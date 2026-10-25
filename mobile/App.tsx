// Hisaab (the Invisible Worker): the vendor's offline ledger, fully on this phone.
import React, { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { service } from './src/app/service';
import { Nav, isUdhaar, type Page } from './src/ui/common';
import { C, useLedgerVersion } from './src/ui/kit';
import { Books } from './src/ui/screens/Books';
import { Entries, EntryDetail } from './src/ui/screens/Entries';
import { Family } from './src/ui/screens/Family';
import { More } from './src/ui/screens/More';
import { Record } from './src/ui/screens/Record';
import { Setup } from './src/ui/screens/Setup';
import { Stock } from './src/ui/screens/Stock';
import { Today } from './src/ui/screens/Today';
import { Udhaar } from './src/ui/screens/Udhaar';
import { Words } from './src/ui/screens/Words';
import { t } from './src/ui/strings';

type Tab = 'today' | 'record' | 'udhaar' | 'stock' | 'more';
const TABS: { key: Tab; icon: string }[] = [
  { key: 'today', icon: '🏠' },
  { key: 'record', icon: '✍️' },
  { key: 'udhaar', icon: '📒' },
  { key: 'stock', icon: '📦' },
  { key: 'more', icon: '☰' },
];

function boot(): boolean {
  const name = service.savedName();
  if (name && !service.ledger) service.open(name);
  return !!service.ledger;
}

export default function App() {
  const [ready, setReady] = useState(boot);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom']}>
        {ready ? <Main /> : <Setup onDone={() => setReady(true)} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Main() {
  const [tab, setTab] = useState<Tab>('today');
  const [stack, setStack] = useState<Page[]>([]);
  const v = useLedgerVersion();
  const badges = useMemo(() => {
    const sum = service.ledger!.summary();
    const udhaar = sum.conflicts.filter((c) => isUdhaar(c.kind) && c.party).length;
    return { udhaar, more: sum.conflicts.length - udhaar + sum.possible_duplicates.length } as Partial<Record<Tab, number>>;
  }, [v]);

  // Android back: close the open page first; only on a tab's main screen does back leave the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length) {
        setStack((st) => st.slice(0, -1));
        return true;
      }
      if (tab !== 'today') {
        setTab('today');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, tab]);

  const nav = useMemo(
    () => ({
      push: (p: Page) => setStack((st) => [...st, p]),
      pop: () => setStack((st) => st.slice(0, -1)),
      tab: (name: string) => {
        setStack([]);
        setTab(name as Tab);
      },
    }),
    [],
  );
  const page = stack[stack.length - 1];

  return (
    <Nav.Provider value={nav}>
      <View style={{ flex: 1 }}>
        {page ? (
          page.name === 'entries' ? <Entries /> :
          page.name === 'entry' ? <EntryDetail key={page.id} id={page.id} /> :
          page.name === 'books' ? <Books /> :
          page.name === 'words' ? <Words /> :
          <Family />
        ) : (
          <>
            {tab === 'today' && <Today />}
            {tab === 'record' && <Record />}
            {tab === 'udhaar' && <Udhaar />}
            {tab === 'stock' && <Stock />}
            {tab === 'more' && <More />}
          </>
        )}
      </View>
      <View style={st.bar}>
        {TABS.map(({ key, icon }) => {
          const on = tab === key && !page;
          const badge = badges[key] ?? 0;
          return (
            <Pressable key={key} onPress={() => nav.tab(key)} style={st.tab} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.tabs[key]}>
              <View>
                <Text style={[st.icon, !on && { opacity: 0.7 }]}>{icon}</Text>
                {badge ? <Text style={st.badge}>{badge}</Text> : null}
              </View>
              <Text style={[st.label, on && { color: C.brand, fontWeight: '800' }]}>{t.tabs[key]}</Text>
              {on ? <View style={st.dot} /> : null}
            </Pressable>
          );
        })}
      </View>
    </Nav.Provider>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: '#fff', paddingTop: 4 },
  tab: { flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', gap: 2 },
  icon: { fontSize: 24 },
  label: { fontSize: 14, color: C.muted },
  dot: { width: 22, height: 3, borderRadius: 2, backgroundColor: C.brand, marginTop: 2 },
  badge: { position: 'absolute', top: -4, right: -12, backgroundColor: C.warn, color: '#fff', fontSize: 11, fontWeight: '800', borderRadius: 9, paddingHorizontal: 5, overflow: 'hidden' },
});
