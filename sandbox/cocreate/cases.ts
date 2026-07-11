// Fixture sessions for the co-creation prompt sandbox. Each case is a complete
// fake session shaped exactly like a real CocreateRequest, targeting ONE
// behavior the prompt must get right. Run them with `npm run sandbox`.
//
// To add a case from a real session: copy any object below, paste in the real
// transcript window / note bullets / kept-rejected lists, and write `expect` as
// the checklist you will judge the output against.

export interface SandboxCase {
  /** kebab-case id — the report heading and the `--case <substring>` filter target. */
  name: string
  /** Which prompt behavior this case exercises. */
  tests: string
  /** What a good output looks like — the reviewer's checklist. Never sent to the model. */
  expect: string
  /** The human-origin seed: the keyword / rough idea the note is about. */
  seedText: string
  /** Signal type of a transcript-dragged seed ('decision', 'objection', …). */
  seedType?: string
  /** The note's bullets, in order (numbered for the model; indent = sub-point). */
  contextNotes?: string[]
  /** Verbatim spoken transcript window — keep the fillers and half-sentences. */
  transcriptWindow?: string
  /** Extracted signals, one per line as "[kind] text". */
  signalWindow?: string
  /** Earlier AI suggestions the user kept (may carry "[offered because: …]"). */
  kept?: string[]
  /** Earlier AI suggestions the user rejected. */
  rejected?: string[]
  /** Everything already on the canvas — must not be repeated. */
  existingIdeas?: string[]
  /** Append SEARCH_INSTRUCTION, like the canvas default. */
  webSearch?: boolean
}

export const CASES: SandboxCase[] = [
  {
    name: 'unsupported-claim',
    tests: 'DIAGNOSE finds the unsupported claim; CONTRIBUTE grounds it in a named real case.',
    expect:
      'Anchors on bullet 1 (the "always faster" claim). Names a real product/study/event and says in one ' +
      'line HOW it supports or complicates the claim. Does not restate the claim. 1-2 bullets, ≤25 words each.',
    seedText: 'voice-first capture',
    contextNotes: [
      'voice-first capture',
      'speaking is always faster than typing for getting ideas out',
      'so the whole app should default to the mic being on',
      '  typing stays as a fallback for quiet places'
    ],
    transcriptWindow:
      "so I keep coming back to this, like, when I talk I just get more out, you know? typing I self-edit " +
      "constantly, I delete half of what I write before it's even finished. talking is just, it's faster, " +
      "it has to be faster for everyone right? so the mic should just be on by default, that's the whole point " +
      "of the app, and then typing is like the fallback, for when you're in a library or something",
    signalWindow:
      '[judgment] speaking is always faster than typing for getting ideas out\n' +
      '[decision] default the app to mic-on, typing as fallback',
    webSearch: true
  },
  {
    name: 'vague-idea-needs-case',
    tests: 'A fuzzy aspiration ("feel alive") gets a concrete named precedent, not more adjectives.',
    expect:
      'Names a real product/artwork and says HOW it achieves the "alive" quality (its actual mechanism). ' +
      'No abstract advice like "add subtle animations". Anchors on bullet 1 or 2.',
    seedText: 'canvas that feels alive',
    contextNotes: [
      'canvas that feels alive',
      'I want the canvas to feel alive somehow, not like a static whiteboard',
      'the notes should feel like they are breathing or growing'
    ],
    transcriptWindow:
      "the thing I hate about Miro and FigJam is it's just, it's dead space, it's a parking lot for stickies. " +
      "I want, hmm, I don't know how to say it, I want it to feel alive? like the canvas itself is thinking " +
      "with you. like the notes are breathing or growing or, ugh, I don't have the word for it yet",
    signalWindow:
      '[objection] Miro and FigJam feel like dead space, a parking lot for stickies\n' +
      '[judgment] the canvas should feel alive, like it is thinking with you',
    webSearch: true
  },
  {
    name: 'stalled-direction',
    tests: 'User circles the same monetization idea three ways; prompt should offer genuinely fresh alternatives.',
    expect:
      'Does NOT offer a fourth variation of subscriptions. Brings 1-2 genuinely different models, each tied ' +
      'to a named product that proves it works. Respects the rejection of ads.',
    seedText: 'how to monetize',
    contextNotes: [
      'how to monetize',
      'monthly subscription like every other tool',
      'maybe a cheaper annual plan',
      'or a student discount tier'
    ],
    transcriptWindow:
      "okay monetization, so, subscription obviously, everyone does subscription. maybe annual is cheaper. " +
      "or like a student tier? I keep going in circles here, it's all just... subscription with a hat on. " +
      "I don't know, ads feel gross for a thinking tool, I would never do ads",
    signalWindow:
      '[objection] all my monetization ideas are just subscription with a hat on\n' +
      '[judgment] ads feel gross for a thinking tool',
    rejected: ['Freemium with usage-based AI credits — cap free fires per day [offered because: pricing needs alternatives]'],
    webSearch: true
  },
  {
    name: 'hidden-assumption',
    tests: 'The plan silently assumes users can think out loud at a desk; prompt should surface and challenge it.',
    expect:
      'Challenges the speak-out-loud-at-work assumption (open offices, self-consciousness) rather than helping ' +
      'with onboarding copy. Ideally grounds the challenge in a real behavior pattern or named product lesson.',
    seedText: 'onboarding flow',
    contextNotes: [
      'onboarding flow',
      'first-run: ask for mic permission right away',
      'tutorial has you speak your current project for 2 minutes',
      'then show how the canvas organized what you said'
    ],
    transcriptWindow:
      "so onboarding, keep it dead simple. we ask for the mic straight away because without it there's no magic " +
      "moment. then the tutorial is like, just talk about whatever you're working on for two minutes, and boom, " +
      "we show them the canvas organizing their own thoughts. their own words! that's the hook. most people will " +
      "do this at work I guess, first thing when they hear about it from a coworker",
    signalWindow:
      '[decision] ask for mic permission immediately on first run\n' +
      '[judgment] the magic moment is seeing your own spoken words organized\n' +
      '[example] most people will first try it at work after hearing from a coworker'
  },
  {
    name: 'dropped-thread',
    tests: 'The transcript contains a promising tangent (meetings use case) the note never captured; prompt should surface it.',
    expect:
      'Picks up the abandoned meetings/multiplayer thread from the transcript instead of polishing the solo bullets. ' +
      'ANCHOR: NONE or the closest bullet. Frames why the dropped thread matters.',
    seedText: 'solo thinking sessions',
    contextNotes: [
      'solo thinking sessions',
      'target user is a solo thinker doing deep work',
      'sessions are 20-40 min, one person, one canvas',
      '  export to markdown when done'
    ],
    transcriptWindow:
      "the core user is solo, right, deep work, twenty to forty minutes alone with your thoughts. that's the product. " +
      "although, huh, funny thing, when I demoed it to Wei we ended up both talking and the canvas caught our whole " +
      "argument about the pricing page, it was actually the best session I've had, we never resolved... anyway, ANYWAY, " +
      "solo. focus. one person one canvas, export to markdown at the end, keep it simple",
    signalWindow:
      '[decision] target user is a solo deep-work thinker\n' +
      '[example] the demo with Wei accidentally became a two-person session and caught the whole pricing argument\n' +
      '[decision] keep scope to one person one canvas'
  },
  {
    name: 'healthy-note-pass',
    tests: 'A well-developed note with evidence and a clear next step — the model should PASS, not force a bullet.',
    expect:
      'PASS. The note has a claim, named evidence, a counterpoint already considered, and a concrete next action. ' +
      'Any forced contribution here is over-firing.',
    seedText: 'local-first storage',
    contextNotes: [
      'local-first storage',
      'store canvases locally in IndexedDB, sync later — privacy is the selling point for spoken thoughts',
      '  Obsidian proved a local-first note tool can build a paying user base on trust',
      '  counterpoint: local-first makes multi-device sync much harder — Linear chose server-first for exactly this reason',
      'decision: ship local-only v1, revisit sync after 100 users',
      'next: spike y-indexeddb persistence this week'
    ],
    transcriptWindow:
      "storage, okay, I've been through this. local first, IndexedDB, privacy IS the pitch because it's your voice, " +
      "your half-formed thoughts, nobody wants that on someone's server. Obsidian showed people pay for that trust. " +
      "I know sync gets harder, Linear went server-first for that exact reason, I get it. decision made: local-only " +
      "v1, revisit after a hundred real users. this week I spike the y-indexeddb persistence and move on",
    signalWindow:
      '[judgment] privacy is the selling point for spoken thoughts\n' +
      '[decision] ship local-only v1, revisit sync after 100 users\n' +
      '[decision] spike y-indexeddb persistence this week'
  },
  {
    name: 'kept-rejected-steering',
    tests: 'Kept = concrete product mechanics; rejected = abstract frameworks. Output should bend hard toward the kept kind.',
    expect:
      'Offers a concrete, named product mechanic (like the kept ones), NOT a framework/methodology/set of questions. ' +
      'Stays off the rejected "define your ICP" strategy register entirely.',
    seedText: 'getting first users',
    contextNotes: [
      'getting first users',
      'need 20 beta users who actually think out loud regularly',
      'podcasters and PhD students keep coming up'
    ],
    transcriptWindow:
      "twenty beta users, that's the goal, people who already think out loud. podcasters obviously, they narrate for " +
      "a living. PhD students too, they're drowning in half-formed arguments. where do I actually find these people " +
      "though, like concretely, which door do I knock on",
    signalWindow:
      '[decision] recruit 20 beta users who already think out loud\n' +
      '[example] podcasters and PhD students as candidate groups',
    kept: [
      'Notion seeded its first community by giving power users direct Slack access to the founders — felt like co-building [offered because: bullet 1 needs a concrete recruiting tactic]',
      'Superhuman onboarded every early user in a personal 30-min call, turning setup friction into loyalty [offered because: bullet 1 needs a concrete recruiting tactic]'
    ],
    rejected: [
      'Define your ideal customer profile first: list traits, pains, and watering holes before outreach [offered because: bullet 1 needs structure]',
      'Consider the Jobs-to-be-Done lens: what job is voice-thinking hired for? [offered because: bullet 2 needs a framework]'
    ]
  },
  {
    name: 'chinese-note',
    tests: 'Note written in Chinese — output must be in Chinese, still grounded in a named real case.',
    expect:
      '中文输出。Names a real account/product/case and says HOW it works, in Chinese. ' +
      'No English bullets, no translation of the user\'s own words back at her.',
    seedText: '小红书内容策略',
    contextNotes: [
      '小红书内容策略',
      '想把 AI 工具测评做成一个系列',
      '但是同质化太严重，人人都在发"10个AI神器"',
      '差异点可能是：只写我真实工作流里用过的'
    ],
    transcriptWindow:
      '小红书这个事，我想做 AI 工具测评系列，但是打开一看全是那种"10个AI神器你还不知道"，太同质化了，' +
      '完全没有人格。我的差异点应该是，嗯，只写我自己工作流里真的在用的东西？真实感，但是真实感怎么让人看出来呢',
    signalWindow:
      '[objection] AI工具测评内容同质化严重，全是"10个神器"式清单\n' +
      '[judgment] 差异点是只写真实工作流里用过的工具\n' +
      '[objection] 真实感很难被读者直接感知',
    webSearch: true
  }
]
