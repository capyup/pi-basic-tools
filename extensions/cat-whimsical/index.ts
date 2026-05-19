/**
 * Capy Tools working-message renderer, forked from
 * [pi-cat-whimsical](https://github.com/lulucatdev/pi-cat-whimsical) (MIT,
 * lulucatdev).
 *
 * Capy means capybara (卡皮巴拉). The extension renders calm animal-life
 * narration as pi's working message instead of the default spinner text.
 * Bundling it into Capy Tools keeps registration order under this package's
 * control: it is placed AFTER `todoExtension` in `extensions/index.ts` so the
 * working message sits below the todo overlay in pi's UI.
 *
 * Settings are now centralized in `~/.pi/agent/capy-tools.json` and exposed
 * through `/capy-tools-settings`. The old `~/.pi/agent/cat-whimsical.json`
 * file is read once as a migration source so existing language preferences
 * carry over.
 *
 * See `extensions/cat-whimsical/LICENSE` for the original MIT copyright
 * notice.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

import { getCapyToolsSettings, restoreCapyToolsSettings, type Language } from "../capy-tools-config.ts";

const WORKING_MESSAGE_WIDGET_KEY = "capy-tools-working-message";

type MessageSet = {
  timePhrases: string[];
  actions: string[];
  thoughts: string[];
  rareMoments: string[];
  separator: string;
};

const MESSAGE_SETS: Record<Language, MessageSet> = {
  en: {
    timePhrases: [
      "During the first patrol of the morning",
      "When the afternoon sleepiness starts to spread",
      "After a stretch beside the window",
      "Once the warmest spot in the room is secured",
      "As the house finally grows quiet at night",
      "Shortly before dinner negotiations begin",
      "After returning from a small and unexplained disappearance",
      "While keeping one eye on the room and one on the food situation",
    ],
    actions: [
      "the cat is inspecting the border of the territory from the windowsill",
      "the cat is supervising progress from the keyboard with the tail wrapped neatly around the paws",
      "the cat is deciding which seat deserves occupation next",
      "the cat is applying measured pressure in the direction of the food bowl",
      "the cat is pretending to sleep while preserving full executive oversight",
      "the cat is reviewing every change in the room with managerial seriousness",
      "the cat is considering whether walking across the keyboard would improve outcomes",
      "the cat is redefining the most inconvenient corner as the ideal companion seat",
      "the cat is conducting a patrol so slow that it becomes ceremonial",
      "the cat is maintaining comfort and dignity within acceptable limits",
      "the cat is waiting under the desk for a reason to sprint without warning",
      "the cat is turning quiet observation into a complete management system",
    ],
    thoughts: [
      "you remain provisionally acceptable",
      "however dinner still lacks a sufficient implementation plan",
      "closer supervision may be required",
      "the situation is stable unless you continue to delay",
      "a mature cat understands the value of waiting before intervening",
      "for now no stronger measures are necessary",
      "this task still appears less important than sunlight",
      "your work has barely reached the threshold for respectable observation",
      "the household continues to require disciplined governance",
      "companionship should not be mistaken for an unlimited entitlement",
    ],
    rareMoments: [
      "the cat has remembered an urgent matter with no public explanation and has already raced out of the room",
      "a patch of sunlight has moved across the floor, so the day has been replanned immediately",
      "the cat has completed an unannounced high-speed crossing and is now restoring dignity",
      "the empty space beside your hand has been formally redesignated as feline office property",
      "because you appeared ready to focus, the cat has chosen this exact moment to sit in the center",
      "everything has been re-sniffed for quality assurance and the conclusions remain classified",
    ],
    separator: ", ",
  },
  zh: {
    timePhrases: [
      "清晨的第一轮巡视里",
      "上午的阳光刚刚合适",
      "午后的困意正在扩大",
      "傍晚的空气有一点松弛",
      "深夜的屋子终于安静下来",
      "饭点前的气氛逐渐紧张",
      "刚从一小段午睡里醒来",
      "在窗边蹲了一阵之后",
      "换到更暖的位置之后",
      "确认领地暂时稳定之后",
    ],
    actions: [
      "猫正在沿着窗台检查领地边界",
      "猫正把尾巴绕好，坐在键盘旁边监督进度",
      "猫正在挑选今天最值得占据的位置",
      "猫正缓慢地向食盆方向施加压力",
      "猫正在用不动声色的注视提醒人类别忘了正事",
      "猫正在假装睡着，同时保留对全局的判断",
      "猫正以家中管理者的身份复核一切动静",
      "猫正在决定是否要踩上键盘以表达参与感",
      "猫正在进行一场极其缓慢但态度明确的巡逻",
      "猫正在把舒适和尊严同时维持在可接受范围内",
      "猫正在桌下积蓄某种突然奔跑的冲动",
      "猫正认真地把沉默变成一种管理方式",
    ],
    thoughts: [
      "猫认为你暂时还算勤勉",
      "不过晚饭问题仍未解决",
      "人类似乎需要更近距离的监督",
      "一切基本可控，除非你继续拖延",
      "一只成熟的猫知道何时按兵不动",
      "目前不必采取更激烈的措施",
      "这件事目前看起来没有晒太阳重要",
      "你的工作状态勉强达到了可观察标准",
      "这个家仍然需要持续管理",
      "人类最好不要把这份陪伴视为理所当然",
    ],
    rareMoments: [
      "猫突然想起一件极其重要但无法解释的事，于是已经冲了出去",
      "猫发现一小块阳光正好落在地上，因此今日计划被当场改写",
      "猫刚刚完成一次毫无预警的高速穿越，现在正在恢复体面",
      "你手边那一小块空位，已经被正式划归为猫的办公区域",
      "猫看见你正准备专心工作，因此决定现在过来坐下",
      "猫已经把屋里的一切重新闻了一遍，结论暂不公开",
    ],
    separator: "，",
  },
  ja: {
    timePhrases: [
      "朝の最初の見回りのあとで",
      "午後の眠気が広がりはじめたころ",
      "窓辺でしばらく様子を見たあとで",
      "部屋でいちばん暖かい場所を確保したあとで",
      "夜になって家の中がようやく静かになり",
      "夕飯の交渉が始まる少し前に",
      "短い昼寝から目を覚ましたところで",
      "縄張りの安定をひとまず確認したあとで",
    ],
    actions: [
      "猫が窓辺から縄張りの境界を点検している",
      "猫がしっぽをきれいに巻いてキーボードの横で進捗を監督している",
      "猫が次に占拠するべき席を慎重に選んでいる",
      "猫がごはんの皿の方向へ静かな圧力をかけている",
      "猫が眠っているふりをしながら全体状況を把握している",
      "猫が家の管理者として室内の変化を厳密に審査している",
      "猫がキーボードの上を歩くべきかどうかを検討している",
      "猫がいちばん不便な場所を最良の同席位置として再定義している",
      "猫がとてもゆっくりだが明確な意思を持った巡回を行っている",
      "猫が快適さと品位を同時に維持している",
      "猫が机の下で突然走り出す理由をためている",
      "猫が沈黙そのものを管理手段に変えている",
    ],
    thoughts: [
      "いまのところ君は許容範囲に収まっている",
      "ただし夕飯の計画はまだ不十分である",
      "もう少し近距離の監督が必要かもしれない",
      "君が先延ばしを続けない限り状況は安定している",
      "成熟した猫は介入の時機を知っている",
      "現時点ではより強い措置は不要である",
      "この件は日向ぼっこより重要には見えない",
      "君の作業はようやく観察に値する水準に達した",
      "この家には継続的な統治が必要である",
      "この同席を当然視すべきではない",
    ],
    rareMoments: [
      "猫は説明不能だが重要な案件を思い出し、すでに部屋の外へ走っていった",
      "日なたが床を移動したため、今日の計画は即座に改訂された",
      "猫は予告なしの高速横断を完了し、いまは品位の回復に努めている",
      "君の手元の空きスペースは猫の執務区域として正式に再指定された",
      "君が集中しようとしたのを見て、猫はこの瞬間に中央へ座ることを選んだ",
      "猫は部屋のあらゆるものを改めて嗅いで確認し、結論は非公開としている",
    ],
    separator: "、",
  },
  ko: {
    timePhrases: [
      "아침 첫 순찰을 마친 뒤",
      "오후의 졸음이 서서히 번질 무렵",
      "창가에서 한참 상황을 살핀 뒤",
      "방 안에서 가장 따뜻한 자리를 확보한 뒤",
      "밤이 되어 집 안이 마침내 조용해졌을 때",
      "저녁 식사 협상이 시작되기 직전에",
      "짧은 낮잠에서 막 깨어난 뒤",
      "영역이 일단 안정적이라고 판단한 뒤",
    ],
    actions: [
      "고양이가 창가에서 영역의 경계를 점검하고 있다",
      "고양이가 꼬리를 단정히 말고 키보드 옆에서 진행 상황을 감독하고 있다",
      "고양이가 다음으로 점거할 자리를 신중하게 고르고 있다",
      "고양이가 밥그릇 방향으로 조용한 압박을 가하고 있다",
      "고양이가 잠든 척하면서도 전체 상황을 계속 파악하고 있다",
      "고양이가 집안 관리자답게 모든 변화를 엄격하게 검토하고 있다",
      "고양이가 키보드를 밟는 것이 성과 개선에 도움이 될지 검토하고 있다",
      "고양이가 가장 불편한 자리를 최적의 동행 자리로 다시 정의하고 있다",
      "고양이가 매우 느리지만 분명한 의지가 담긴 순찰을 수행하고 있다",
      "고양이가 편안함과 품위를 동시에 유지하고 있다",
      "고양이가 책상 아래에서 갑작스럽게 달릴 이유를 축적하고 있다",
      "고양이가 침묵 자체를 관리 방식으로 바꾸고 있다",
    ],
    thoughts: [
      "현재로서는 당신이 허용 가능한 범위에 있다",
      "다만 저녁 식사 계획은 아직 충분하지 않다",
      "조금 더 가까운 거리의 감독이 필요할 수 있다",
      "당신이 계속 미루지 않는 한 상황은 안정적이다",
      "성숙한 고양이는 개입할 시점을 알고 있다",
      "지금은 더 강한 조치가 필요하지 않다",
      "이 일은 햇볕보다 중요해 보이지 않는다",
      "당신의 작업은 이제야 관찰할 가치가 있는 수준에 도달했다",
      "이 집에는 지속적인 통치가 필요하다",
      "이 동행을 당연한 권리로 여겨서는 안 된다",
    ],
    rareMoments: [
      "고양이가 설명할 수는 없지만 중요한 사안을 떠올렸고 이미 방 밖으로 질주했다",
      "햇빛 한 조각이 바닥을 옮겨 갔으므로 오늘의 계획이 즉시 수정되었다",
      "고양이가 예고 없는 고속 횡단을 마쳤고 지금은 품위를 회복하는 중이다",
      "당신 손 옆의 빈 공간은 공식적으로 고양이 업무 구역으로 재지정되었다",
      "당신이 집중하려는 순간을 보고 고양이는 바로 지금 중앙에 앉기로 결정했다",
      "고양이가 집 안의 모든 것을 다시 냄새로 확인했고 결론은 비공개 상태다",
    ],
    separator: ", ",
  },
};

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function finish(message: string): string {
  return `${message.trim().replace(/[.。!！?？]+$/u, "")}...`;
}

export default function workingMessageExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    await restoreCapyToolsSettings();
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const settings = getCapyToolsSettings();
    const message = pickRandom(settings.workingMessage.language);
    // Pi's built-in working loader lives in the status container, which is
    // above extension widgets. Render our own loader widget instead so it can
    // sit after the todo widget in the above-editor stack.
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWidget(
      WORKING_MESSAGE_WIDGET_KEY,
      (tui, theme) => {
        const loader = new Loader(
          tui,
          (spinner) => theme.fg("accent", spinner),
          (text) => theme.fg("muted", text),
          message,
        );
        loader.start();
        return Object.assign(loader, { dispose: () => loader.stop() });
      },
      { placement: "aboveEditor" },
    );
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget(WORKING_MESSAGE_WIDGET_KEY, undefined);
    ctx.ui.setWorkingVisible(true);
  });
}
