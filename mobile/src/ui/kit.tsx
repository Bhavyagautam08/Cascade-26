// Shared look for the phone: big type, big touch targets (>= 56 dp), one main action per card.
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle, type ViewStyle } from 'react-native';
import { service } from '../app/service';
import { t } from './strings';

export const C = {
  bg: '#F4F1EA',
  card: '#FFFFFF',
  ink: '#1C1B19',
  muted: '#6B675F',
  faint: '#9A958B',
  line: '#E4DFD4',
  brand: '#1F6F5C',
  brandSoft: '#E3F0EC',
  brandInk: '#FFFFFF',
  good: '#1F7A3A',
  goodSoft: '#E5F3E8',
  warn: '#A35400',
  warnSoft: '#FFF1DE',
  bad: '#B3261E',
  badSoft: '#FCE8E6',
  head: '#173F35',
};

// One colour per kind of entry, so the list reads at a glance.
export const KIND_COLOR: Record<string, [string, string]> = {
  sale: ['#1F7A3A', '#E5F3E8'],
  purchase: ['#2F5DA8', '#E7EEFA'],
  credit_given: ['#A35400', '#FFF1DE'],
  credit_paid: ['#6B4FA8', '#EFEAFA'],
  expense: ['#B3261E', '#FCE8E6'],
  stock_count: ['#4B5563', '#EEF0F2'],
  opening_stock: ['#4B5563', '#EEF0F2'],
  order: ['#7A6A00', '#FBF6D9'],
  day_start: ['#173F35', '#E3F0EC'],
  adjustment: ['#6B675F', '#EFEDE8'],
};

/** Indian grouping: 125000 -> "1,25,000". */
export function inr(rupees: number): string {
  const neg = rupees < 0;
  const r = Math.round(Math.abs(rupees));
  const s = String(r);
  const head = s.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}` : s;
  return `${neg ? '−' : ''}₹${grouped}`;
}
/** Paise with up to 2 decimals (the books): 18050 -> "₹180.50". */
export function rupeesExact(paise: number): string {
  const whole = inr(Math.trunc(paise / 100));
  const frac = Math.abs(paise % 100);
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : whole;
}
export const paise = (p: number) => inr(p / 100);
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

/** Re-render when the ledger changes. */
export function useLedgerVersion(): number {
  const [v, setV] = useState(service.version);
  useEffect(() => service.subscribe(() => setV(service.version)), []);
  return v;
}

export function Screen({ title, line, children, onBack }: { title: string; line?: string; children: React.ReactNode; onBack?: () => void }) {
  // Edge-to-edge (Android 15+) ignores adjustResize: lift the content above the keyboard ourselves.
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      {onBack ? (
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={t.back} style={s.back} hitSlop={12}>
          <Text style={s.backText}>‹ {t.back}</Text>
        </Pressable>
      ) : null}
      <Text style={s.h1} accessibilityRole="header">{title}</Text>
      {line ? <Text style={s.line}>{line}</Text> : null}
      {children}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Card({ title, aside, children, style, tone }: { title?: string; aside?: React.ReactNode; children: React.ReactNode; style?: ViewStyle; tone?: 'warn' | 'bad' | 'good' }) {
  const border = tone === 'warn' ? C.warn : tone === 'bad' ? C.bad : tone === 'good' ? C.good : C.line;
  return (
    <View style={[s.card, { borderColor: border }, tone ? { borderLeftWidth: 5 } : null, style]}>
      {title || aside ? (
        <View style={s.cardHead}>
          {title ? <Text style={s.cardTitle}>{title}</Text> : <View />}
          {aside}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Button({ label, onPress, kind = 'main', disabled, small, icon, style }: { label: string; onPress: () => void; kind?: 'main' | 'plain' | 'warn' | 'danger' | 'soft'; disabled?: boolean; small?: boolean; icon?: string; style?: ViewStyle }) {
  const bg = kind === 'main' ? C.brand : kind === 'warn' ? C.warn : kind === 'danger' ? C.bad : kind === 'soft' ? C.brandSoft : 'transparent';
  const fg = kind === 'plain' || kind === 'soft' ? C.brand : C.brandInk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg }, kind === 'plain' && s.btnPlain, (pressed || disabled) && { opacity: 0.55 }, style]}
    >
      <Text style={[s.btnText, small && { fontSize: 16 }, { color: fg }]}>{icon ? `${icon}  ` : ''}{label}</Text>
    </Pressable>
  );
}

/** A row of equal buttons (e.g. ✓ Sahi · ✎ Badlo · 🗑 Hatao). */
export function Actions({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 8 }}>{React.Children.map(children, (c) => (c ? <View style={{ flex: 1 }}>{c}</View> : null))}</View>;
}

/** A label above an input. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4, flex: 1 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

/** A text input; for secrets (the family key) an eye inside the box shows or hides what was typed. */
export function Input({ secret, style, ...props }: React.ComponentProps<typeof TextInput> & { secret?: boolean }) {
  const [shown, setShown] = useState(false);
  if (!secret) return <TextInput placeholderTextColor={C.faint} {...props} style={[s.input, style]} />;
  return (
    <View style={[s.input, s.inputRow, style]}>
      <TextInput
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        secureTextEntry={!shown}
        style={{ flex: 1, fontSize: shown ? 22 : 18, color: C.ink, letterSpacing: shown ? 2 : 0, fontFamily: shown ? 'monospace' : undefined, paddingVertical: 8 }}
      />
      <Pressable
        onPress={() => setShown((x) => !x)}
        accessibilityRole="button"
        accessibilityLabel={shown ? t.secret.hide : t.secret.show}
        hitSlop={10}
        style={({ pressed }) => [s.eye, pressed && { opacity: 0.6 }]}
      >
        <Text style={{ fontSize: 20 }}>{shown ? '🙈' : '👁️'}</Text>
        <Text style={{ fontSize: 12, color: C.brand, fontWeight: '700' }}>{shown ? t.secret.hide : t.secret.show}</Text>
      </Pressable>
    </View>
  );
}

/** A card that is obviously tappable: a coloured edge, and "Dekho ›" on the right. */
export function Tile({ title, children, onPress, cta, style, tone }: { title: string; children: React.ReactNode; onPress: () => void; cta?: string; style?: ViewStyle; tone?: 'warn' }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}: ${cta ?? t.open}`} style={({ pressed }) => [s.card, s.tile, tone === 'warn' && { borderLeftColor: C.warn }, pressed && { backgroundColor: '#F2F7F5' }, style]}>
      <Text style={s.cardTitle}>{title}</Text>
      {children}
      <View style={s.tileCta}>
        <Text style={s.tileCtaText}>{cta ?? t.open} ›</Text>
      </View>
    </Pressable>
  );
}

/** How loud the mic hears the room; speech has to cross the line to be heard as a sentence. */
export function LevelMeter({ level, threshold, on }: { level: number; threshold?: number; on: boolean }) {
  const scale = Math.max(0.05, (threshold ?? 0.01) * 4);
  const lvl = on ? Math.min(100, (level / scale) * 100) : 0;
  const thr = threshold ? Math.min(100, (threshold / scale) * 100) : null;
  const loud = threshold ? level > threshold : level > 0.02;
  return (
    <View accessibilityLabel={on ? `${t.mic.level} ${Math.round(lvl)}%` : t.mic.off} style={{ height: 14, borderRadius: 7, backgroundColor: '#E8E4DA', overflow: 'hidden', justifyContent: 'center' }}>
      <View style={{ width: `${lvl}%`, height: '100%', backgroundColor: loud ? C.good : '#A8B5AF' }} />
      {thr != null ? <View style={{ position: 'absolute', left: `${thr}%`, top: 0, bottom: 0, width: 3, backgroundColor: C.warn }} /> : null}
    </View>
  );
}

/** The big round microphone button. */
export function MicButton({ on, busy, onPress, label, disabled }: { on: boolean; busy?: boolean; onPress: () => void; label: string; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || busy), checked: on }}
      style={({ pressed }) => [s.micBtn, { backgroundColor: on ? C.bad : C.brand }, (pressed || disabled || busy) && { opacity: 0.6 }]}
    >
      <Text style={{ fontSize: 34 }}>{busy ? '⏳' : on ? '⏹️' : '🎙️'}</Text>
      <Text style={s.micLabel}>{label}</Text>
    </Pressable>
  );
}

/** A small pulsing-looking dot plus words: what the mic is doing right now. */
export function StatusDot({ on, text, tone }: { on: boolean; text: string; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : on ? C.good : C.faint;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} />
      <Text style={{ fontSize: 16, fontWeight: '700', color }}>{text}</Text>
    </View>
  );
}

/** Extra detail, closed until asked for (technical facts, rarely used options). */
export function More({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <Pressable onPress={() => setOpen((x) => !x)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8} style={{ paddingVertical: 6 }}>
        <Text style={{ color: C.brand, fontWeight: '700', fontSize: 16 }}>{open ? '▾' : '▸'} {label}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function Big({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.big, style]}>{children}</Text>;
}
export function Muted({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}
export function Body({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.body, style]}>{children}</Text>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <View style={s.errorBox} accessibilityLiveRegion="polite">
      <Text style={s.errorText}>{t.error(error)}</Text>
    </View>
  ) : null;
}

export function KindTag({ kind, label }: { kind: string; label?: string }) {
  const [fg, bg] = KIND_COLOR[kind] ?? KIND_COLOR.adjustment;
  return <Text style={[s.tag, { color: fg, backgroundColor: bg }]}>{label ?? t.kinds[kind] ?? kind}</Text>;
}

export function Pill({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'muted' | 'good' }) {
  const [fg, bg] = tone === 'warn' ? [C.warn, C.warnSoft] : tone === 'good' ? [C.good, C.goodSoft] : [C.muted, '#EFEDE8'];
  return <Text style={[s.pill, { color: fg, backgroundColor: bg }]}>{children}</Text>;
}

/** How sure the worker is: a short bar plus the number. Under 60 % is marked. */
export function Conf({ value }: { value: number }) {
  const low = value < 0.6;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityLabel={`${pct(value)} ${t.sure}`}>
      <View style={s.confTrack}>
        <View style={[s.confFill, { width: `${Math.round(value * 100)}%`, backgroundColor: low ? C.warn : C.good }]} />
      </View>
      <Text style={[s.small, { color: low ? C.warn : C.muted }]}>{pct(value)}</Text>
    </View>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[s.seg, on && s.segOn]}>
            <Text style={[s.segText, on && { color: C.brandInk }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A number chosen with big − / + buttons (no slider library needed). */
export function Stepper({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.body}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable accessibilityLabel={`${label} kam`} onPress={() => onChange(Math.max(min, value - step))} style={s.stepBtn}><Text style={s.stepText}>−</Text></Pressable>
        <Text style={[s.body, { minWidth: 110, textAlign: 'center', fontWeight: '700' }]}>{value} {unit}</Text>
        <Pressable accessibilityLabel={`${label} zyada`} onPress={() => onChange(Math.min(max, value + step))} style={s.stepBtn}><Text style={s.stepText}>+</Text></Pressable>
      </View>
    </View>
  );
}

/** A range from lo to hi with the likely value marked. */
export function RangeBar({ lo, mid, hi }: { lo: number; mid: number; hi: number }) {
  const span = hi - lo;
  const at = span > 0 ? (mid - lo) / span : 0.5;
  return (
    <View style={{ height: 14, justifyContent: 'center' }} accessibilityElementsHidden>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: C.brandSoft }} />
      <View style={{ position: 'absolute', left: `${Math.round(at * 100)}%`, marginLeft: -7, width: 14, height: 14, borderRadius: 7, backgroundColor: C.brand }} />
    </View>
  );
}

export function Row({ children, onPress, style }: { children: React.ReactNode; onPress?: () => void; style?: ViewStyle }) {
  if (!onPress) return <View style={[s.row, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.row, style, pressed && { backgroundColor: '#F7F5F0' }]}>
      {children}
    </Pressable>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <Text style={[s.muted, { paddingVertical: 8 }]}>{children}</Text>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16, gap: 14, paddingBottom: 40 },
  h1: { fontSize: 28, fontWeight: '800', color: C.head },
  line: { fontSize: 16, color: C.muted, marginTop: -6, lineHeight: 22 },
  back: { alignSelf: 'flex-start', paddingVertical: 4 },
  backText: { fontSize: 18, color: C.brand, fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: C.line, elevation: 1 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.8 },
  big: { fontSize: 32, fontWeight: '800', color: C.ink },
  body: { fontSize: 17, color: C.ink, lineHeight: 23 },
  muted: { fontSize: 15, color: C.muted, lineHeight: 20 },
  small: { fontSize: 13, color: C.muted },
  btn: { minHeight: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnSmall: { minHeight: 48 },
  btnPlain: { borderWidth: 1.5, borderColor: C.brand },
  btnText: { color: C.brandInk, fontSize: 18, fontWeight: '700' },
  input: { minHeight: 56, borderWidth: 1.5, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, fontSize: 18, color: C.ink, backgroundColor: C.card },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  errorBox: { backgroundColor: C.badSoft, borderRadius: 12, padding: 12 },
  errorText: { color: C.bad, fontSize: 16 },
  tag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, fontSize: 13, overflow: 'hidden' },
  confTrack: { width: 44, height: 6, borderRadius: 3, backgroundColor: '#ECE8E0', overflow: 'hidden' },
  confFill: { height: 6, borderRadius: 3 },
  seg: { minHeight: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1.5, borderColor: C.brand, justifyContent: 'center' },
  segOn: { backgroundColor: C.brand },
  segText: { fontSize: 16, fontWeight: '600', color: C.brand },
  stepBtn: { width: 52, height: 52, borderRadius: 26, borderWidth: 1.5, borderColor: C.brand, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 26, color: C.brand, fontWeight: '700', marginTop: -2 },
  mono: { fontFamily: 'monospace', fontSize: 13, color: C.muted },
  label: { fontSize: 14, fontWeight: '700', color: C.muted },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  eye: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, minWidth: 64, minHeight: 48, borderLeftWidth: 1, borderLeftColor: C.line },
  tile: { borderLeftWidth: 5, borderLeftColor: C.brand },
  tileCta: { alignSelf: 'flex-end', backgroundColor: C.brandSoft, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  tileCtaText: { color: C.brand, fontWeight: '800', fontSize: 15 },
  micBtn: { alignSelf: 'center', width: 168, height: 168, borderRadius: 84, alignItems: 'center', justifyContent: 'center', gap: 6, elevation: 4, paddingHorizontal: 10 },
  micLabel: { color: '#fff', fontWeight: '800', fontSize: 16, textAlign: 'center' },
});
