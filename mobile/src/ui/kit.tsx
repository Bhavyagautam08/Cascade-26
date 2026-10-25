// Shared look: big text, big buttons (>= 56 dp), one main action per card, plain colours.
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { service } from '../app/service';
import { t } from './strings';

export const C = {
  bg: '#F7F5F0',
  card: '#FFFFFF',
  ink: '#1C1B19',
  muted: '#6B675F',
  line: '#E4E0D8',
  brand: '#1F6F5C',
  brandInk: '#FFFFFF',
  good: '#1F7A3A',
  warn: '#B25E00',
  bad: '#B3261E',
  warnBg: '#FFF4E5',
};

/** Indian grouping: 125000 -> "1,25,000". No Intl needed. */
export function inr(rupees: number): string {
  const neg = rupees < 0;
  const r = Math.round(Math.abs(rupees));
  const s = String(r);
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${neg ? '−' : ''}₹${grouped}`;
}
export const paise = (p: number) => inr(p / 100);
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Re-render when the ledger changes. */
export function useLedgerVersion(): number {
  const [v, setV] = useState(service.version);
  useEffect(() => service.subscribe(() => setV(service.version)), []);
  return v;
}

export function Card({ title, children, style }: { title?: string; children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Button({ label, onPress, kind = 'main', disabled }: { label: string; onPress: () => void; kind?: 'main' | 'plain' | 'warn'; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, kind === 'plain' && s.btnPlain, kind === 'warn' && s.btnWarn, (pressed || disabled) && { opacity: 0.6 }]}
    >
      <Text style={[s.btnText, kind === 'plain' && { color: C.brand }]}>{label}</Text>
    </Pressable>
  );
}

export function Big({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.big, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <Text style={s.error} accessibilityLiveRegion="polite">{t.error(error)}</Text> : null;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16, gap: 12, paddingBottom: 32 },
  h1: { fontSize: 26, fontWeight: '700', color: C.ink },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: C.line },
  cardTitle: { fontSize: 15, fontWeight: '600', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  big: { fontSize: 30, fontWeight: '700', color: C.ink },
  body: { fontSize: 17, color: C.ink },
  muted: { fontSize: 15, color: C.muted },
  btn: { minHeight: 56, borderRadius: 12, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnPlain: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.brand },
  btnWarn: { backgroundColor: C.warn },
  btnText: { color: C.brandInk, fontSize: 18, fontWeight: '600' },
  input: { minHeight: 56, borderWidth: 1.5, borderColor: C.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 18, color: C.ink, backgroundColor: C.card },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  error: { color: C.bad, fontSize: 16 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: C.warnBg, color: C.warn, fontSize: 13, overflow: 'hidden' },
});
