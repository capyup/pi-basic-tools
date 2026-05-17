#!/usr/bin/env python3
"""Capture a real interactive pi TUI run from a PTY.

This is intentionally an end-to-end harness: it launches `pi` in an actual
pseudo-terminal, records the raw ANSI stream, writes a best-effort plain-text
version, and optionally asserts that expected strings appear in that capture.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import os
import re
import select
import shlex
import signal
import struct
import sys
import termios
import time
from pathlib import Path

DEFAULT_SENTINEL = "DONE_BASIC_TOOLS_CAPTURE"
DEFAULT_PROMPT = """Use exactly these tools in order, with no other tools between them:
1. symbol_outline on extensions/basic-tool-grouping.ts with maxBlocks=4
2. read_block on extensions/basic-tool-grouping.ts for symbol renderGroupLines with context=1
3. grep for pattern BasicToolGroupComponent in extensions/basic-tool-grouping.ts
Then answer exactly: DONE_BASIC_TOOLS_CAPTURE
"""
LEAK_CANARY_PROMPT = """Use exactly these tools in order, with no other tools between them:
1. repo_map on the current project with depth=1 and maxFiles=20
2. read README.md
3. bash command: node -e "console.log(['RAW','LEAK','SENTINEL'].join('_'))"
Then answer exactly: DONE_BASIC_TOOLS_CAPTURE
"""
LEAK_CANARY_EXPECT = ["Explored", "Map", "Read", "Ran"]
LEAK_CANARY_FORBID = ["# repo_map:", "Root:", "Standalone basic tools", "RAW_LEAK_SENTINEL"]

CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
DCS_RE = re.compile(r"\x1bP[\s\S]*?\x1b\\")
ANSI_SINGLE_RE = re.compile(r"\x1b[@-Z\\-_]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_ansi(text: str) -> str:
    text = OSC_RE.sub("", text)
    text = DCS_RE.sub("", text)
    text = CSI_RE.sub("", text)
    text = ANSI_SINGLE_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_RE.sub("", text)
    lines = [line.rstrip() for line in text.split("\n")]
    collapsed: list[str] = []
    previous_blank = False
    for line in lines:
        blank = len(line.strip()) == 0
        if blank and previous_blank:
            continue
        collapsed.append(line)
        previous_blank = blank
    return "\n".join(collapsed).strip() + "\n"


def strip_thinking_summary_lines(text: str) -> str:
    return "\n".join(
        line
        for line in text.splitlines()
        if not line.lstrip().startswith(("┆", "├─", "└─"))
    )


def set_winsize(fd: int, rows: int, cols: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def build_default_command(args: argparse.Namespace) -> list[str]:
    command = [
        args.pi_bin,
        "--no-session",
        "--session-dir",
        str(args.out_dir / "sessions"),
    ]
    if args.current_pi_settings:
        command.append(args.prompt)
        return command

    return [
        *command,
        "--no-extensions",
        "--extension",
        "extensions/index.ts",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        "symbol_outline,read_block,grep",
        args.prompt,
    ]


def spawn_pty(command: list[str], cwd: Path, env: dict[str, str], rows: int, cols: int) -> tuple[int, int]:
    pid, fd = os.forkpty()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(env)
            os.execvp(command[0], command)
        except BaseException as exc:  # pragma: no cover - child process path
            print(f"failed to exec {command[0]}: {exc}", file=sys.stderr)
            os._exit(127)
    set_winsize(fd, rows, cols)
    os.set_blocking(fd, False)
    return pid, fd


def capture(command: list[str], args: argparse.Namespace) -> tuple[int, bytes, bool]:
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    env.setdefault("PI_SKIP_VERSION_CHECK", "1")
    env["COLUMNS"] = str(args.cols)
    env["LINES"] = str(args.rows)

    pid, fd = spawn_pty(command, args.cwd, env, args.rows, args.cols)
    raw = bytearray()
    sentinel_seen = False
    sent_interrupt_at: float | None = None
    deadline = time.time() + args.timeout

    try:
        while True:
            now = time.time()
            if now >= deadline:
                os.kill(pid, signal.SIGTERM)
                time.sleep(0.5)
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break

            readable, _, _ = select.select([fd], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                raw.extend(chunk)
                decoded = raw.decode("utf-8", errors="replace")
                if args.sentinel and args.sentinel in decoded and not sentinel_seen:
                    sentinel_seen = True
                    sent_interrupt_at = time.time() + args.settle

            if sent_interrupt_at is not None and time.time() >= sent_interrupt_at:
                try:
                    os.write(fd, b"\x03")
                except OSError:
                    pass
                sent_interrupt_at = None

            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                return os.waitstatus_to_exitcode(status), bytes(raw), sentinel_seen
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    try:
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), bytes(raw), sentinel_seen
    except ChildProcessError:
        return 124, bytes(raw), sentinel_seen


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture a real pi TUI run from a PTY")
    parser.add_argument("--out-dir", type=Path, default=Path(".pi/tui-captures") / time.strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--pi-bin", default="pi")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--sentinel", default=DEFAULT_SENTINEL)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--settle", type=float, default=2.0, help="seconds to keep capturing after sentinel before Ctrl-C")
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=180)
    parser.add_argument(
        "--current-pi-settings",
        action="store_true",
        help="use the user's normal pi extension/tool settings instead of the isolated local extension setup",
    )
    parser.add_argument(
        "--basic-leak-canary",
        action="store_true",
        help="run a repo_map/read/bash prompt and forbid raw result leaks in the visible capture",
    )
    parser.add_argument("--expect", action="append", default=[], help="plain-text substring that must appear; repeatable")
    parser.add_argument(
        "--expect-tools-block",
        action="append",
        default=[],
        help="substring that must appear with the other --expect-tools-block values in one rendered grouped tool block",
    )
    parser.add_argument("--expect-tools-status", choices=["any", "running", "done", "error"], default="any")
    parser.add_argument("--forbid", action="append", default=[], help="plain-text substring that must not appear; repeatable")
    parser.add_argument("--forbid-ignore-thinking", action="store_true", help="apply --forbid after dropping rendered thinking-summary lines")
    parser.add_argument("--", dest="command", nargs=argparse.REMAINDER, help="custom command to run instead of the default pi command")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.basic_leak_canary:
        args.prompt = LEAK_CANARY_PROMPT
        args.expect.extend(LEAK_CANARY_EXPECT)
        args.forbid.extend(LEAK_CANARY_FORBID)
        args.forbid_ignore_thinking = True
    args.cwd = args.cwd.resolve()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    command = args.command if args.command else build_default_command(args)
    if command and command[0] == "--":
        command = command[1:]

    (args.out_dir / "command.txt").write_text(" ".join(shlex.quote(part) for part in command) + "\n", encoding="utf-8")
    code, raw, sentinel_seen = capture(command, args)
    plain = strip_ansi(raw.decode("utf-8", errors="replace"))

    raw_path = args.out_dir / "raw.ansi"
    plain_path = args.out_dir / "plain.txt"
    raw_path.write_bytes(raw)
    plain_path.write_text(plain, encoding="utf-8")

    expectations = args.expect or ["Explored 3 targets", "Outline", "Read", "Search", args.sentinel]
    failures: list[str] = []
    matched_tools_block: str | None = None
    if args.sentinel and not sentinel_seen:
        failures.append(f"sentinel not seen: {args.sentinel}")
    if code != 0 and not (sentinel_seen and code in {-2, -15, 130, 143}):
        failures.append(f"unexpected pi exit code: {code}")
    for expected in expectations:
        if expected and expected not in plain:
            failures.append(f"missing expected text: {expected}")
    if args.expect_tools_block:
        lines = plain.splitlines()
        if args.expect_tools_status == "any":
            prefixes = ("Ran ", "Edited ", "Explored ", "Fetched ", "Used ")
            tool_blocks = ["\n".join(lines[index : index + 16]) for index, line in enumerate(lines) if line.startswith(prefixes)]
            prefix = "grouped tool"
        else:
            prefix = "grouped tool"
            tool_blocks = ["\n".join(lines[index : index + 16]) for index, line in enumerate(lines) if line.startswith(("Ran ", "Edited ", "Explored ", "Fetched ", "Used "))]
        matched_tools_block = next((block for block in tool_blocks if all(expected in block for expected in args.expect_tools_block)), None)
        if matched_tools_block is None:
            failures.append(f"no single {prefix} block contains: " + ", ".join(args.expect_tools_block))
    forbidden_scope = strip_thinking_summary_lines(plain) if args.forbid_ignore_thinking else plain
    for forbidden in args.forbid:
        if forbidden and forbidden in forbidden_scope:
            failures.append(f"forbidden text present: {forbidden}")

    print(f"capture_dir: {args.out_dir}")
    print(f"raw: {raw_path}")
    print(f"plain: {plain_path}")
    print(f"exit_code: {code}")
    print("--- plain tail ---")
    print("\n".join(plain.splitlines()[-80:]))
    if matched_tools_block:
        print("--- matched grouped tool block ---")
        print(matched_tools_block)

    if failures:
        print("--- failures ---", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
