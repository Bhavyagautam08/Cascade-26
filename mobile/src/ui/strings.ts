// Every word the app shows, in Hinglish (Roman Hindi, digits 0-9), as the team decided for version 1.
// Another language later = another object with the same keys. No accounting words on screen.
export const hi = {
  app: 'Hisaab',
  tabs: { today: 'Aaj', record: 'Likho', udhaar: 'Udhaar', stock: 'Stock', more: 'Aur' },

  setup: {
    title: 'Is phone ka naam',
    line: 'Har phone ka apna naam: phone-1, phone-2, phone-3. Ek baar rakhte hain, phir nahi badalta.',
    name: 'Naam (jaise phone-1)',
    key: 'Parivaar ki chaabi (sab phones par same)',
    keyHint: 'Pehle phone par nayi banaiye, baaki phones par wahi likhiye.',
    newKey: 'Nayi chaabi banao',
    save: 'Shuru karein',
  },

  today: {
    title: (day: string) => `Aaj · ${day}`,
    beforeFirstDay: 'Pehla din abhi shuru nahi hua',
    day: (n: number, date: string | null) => (date ? `Din ${n} · ${date}` : `Din ${n}`),
    earnings: 'Aaj ki asli kamai',
    earningsRange: (lo: string, hi: string, mid: string) => `${lo} se ${hi} ke beech, sabse zyada ${mid}`,
    earningsSure: (v: string) => `${v} (pakka)`,
    udhaar: 'Udhaar baaki',
    cash: 'Galle mein',
    needsYou: 'Aapke liye',
    nothingNeeded: 'Kuch karna baaki nahi',
    entries: 'Aaj ke hisaab',
    noEntries: 'Aaj abhi kuch nahi likha. Likho par jaiye.',
    newDay: 'Naya din shuru karo',
    newDayConfirm: 'Naya din shuru karein? Purana hisaab mitega nahi; udhaar aur galla aage chalega.',
    settle: (what: string) => `${what}: kitna tha?`,
    twice: (what: string) => `${what}: ek baar ya do baar?`,
    unsure: (what: string) => `Check karein: ${what}`,
  },

  record: {
    title: 'Hisaab likho',
    placeholder: 'Jaise: 3 kilo tamatar liya 180 mein, Sharma ji ka 40 jama',
    add: 'Jodo',
    sms: 'Bank / UPI SMS hai',
    booked: (n: number) => (n === 1 ? '1 hisaab juda' : `${n} hisaab jude`),
    nothing: 'Isme koi len-den nahi mila',
    unparsed: 'Samajh nahi aaya',
    rulesOnly: (why: string) => `Bina model ke padha (${why})`,
    listen: 'Bolo',
    slip: 'Parchi ki photo',
    comingSoon: 'Jaldi aa raha hai',
  },

  udhaar: {
    title: 'Udhaar ki kitaab',
    total: (n: number, amt: string) => (n === 1 ? `1 grahak par ${amt} baaki` : `${n} grahakon par ${amt} baaki`),
    none: 'Kisi par kuch baaki nahi',
    settled: 'Hisaab saaf',
    ahead: (amt: string) => `${amt} zyada de diya`,
    disputed: (amt: string) => `${amt} pakka nahi, check karein`,
  },

  dispute: {
    itWas: (amt: string) => `${amt} tha`,
    other: 'Aur',
    set: 'Rakho',
    phones: (a: string, b: string) => `${a} aur ${b} ne alag suna`,
    booked: (amt: string) => `Abhi ${amt} likha hai`,
    one: 'Ek hi hai',
    two: 'Do alag hain',
  },

  stock: { title: 'Stock', soon: 'Subah aur shaam ki ginti yahan aayegi' },

  more: {
    title: 'Aur',
    books: 'Pura hisaab (khaata)',
    balanced: 'Khaata barabar hai',
    notBalanced: 'Khaata barabar nahi',
    countedOnce: 'Ek hi len-den, ek baar gina',
    different: 'Ye alag len-den hain',
    family: 'Parivaar ke phones',
    thisPhone: 'Ye phone',
    peerOk: (ago: string) => `Juda hua, ${ago}`,
    peerAway: 'Door hai / band hai',
    peerRefused: 'Chaabi galat',
    peerError: 'Gadbad',
    syncNow: 'Abhi milao',
    noPeers: 'Abhi koi aur phone nahi joda',
    entries: 'Saare hisaab',
  },

  kinds: {
    purchase: 'Kharida',
    sale: 'Becha',
    credit_given: 'Udhaar diya',
    credit_paid: 'Udhaar wapas',
    expense: 'Kharcha',
    stock_count: 'Stock gina',
    order: 'Mangaya (daam nahi)',
    opening_stock: 'Subah ka stock',
    day_start: 'Naya din',
    adjustment: 'Sudhaar',
  } as Record<string, string>,

  error: (msg: string) => `Gadbad: ${msg}`,
  secondsAgo: (s: number) => (s < 60 ? `${Math.round(s)} second pehle` : s < 3600 ? `${Math.round(s / 60)} minute pehle` : `${(s / 3600).toFixed(1)} ghante pehle`),
};

export type Strings = typeof hi;
export const t: Strings = hi;
