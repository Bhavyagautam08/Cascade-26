// Shared look for the phone: big type, big touch targets (>= 56 dp), one main action per card.
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
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

export function Button({ label, onPress, kind = 'main', disabled, small }: { label: string; onPress: () => void; kind?: 'main' | 'plain' | 'warn' | 'danger'; disabled?: boolean; small?: boolean }) {
  const bg = kind === 'main' ? C.brand : kind === 'warn' ? C.warn : kind === 'danger' ? C.bad : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg }, kind === 'plain' && s.btnPlain, (pressed || disabled) && { opacity: 0.55 }]}
    >
      <Text style={[s.btnText, small && { fontSize: 16 }, kind === 'plain' && { color: C.brand }]}>{label}</Text>
    </Pressable>
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

export function KindTag({ kind }: { kind: string }) {
  const [fg, bg] = KIND_COLOR[kind] ?? KIND_COLOR.adjustment;
  return <Text style={[s.tag, { color: fg, backgroundColor: bg }]}>{t.kinds[kind] ?? kind}</Text>;
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
});
