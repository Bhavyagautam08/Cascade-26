// Hisaab (the Invisible Worker): the vendor's offline ledger, fully on this phone.
import React, { useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { service } from './src/app/service';
import { C } from './src/ui/kit';
import { More, Record, Setup, Stock, Today, Udhaar } from './src/ui/screens';
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
  const [tab, setTab] = useState<Tab>('today');
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom']}>
        {!ready ? (
          <Setup onDone={() => setReady(true)} />
        ) : (
          <>
            <View style={{ flex: 1 }}>
              {tab === 'today' && <Today />}
              {tab === 'record' && <Record />}
              {tab === 'udhaar' && <Udhaar />}
              {tab === 'stock' && <Stock />}
              {tab === 'more' && <More />}
            </View>
            <View style={st.bar}>
              {TABS.map(({ key, icon }) => (
                <Pressable key={key} onPress={() => setTab(key)} style={st.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} accessibilityLabel={t.tabs[key]}>
                  <Text style={st.icon}>{icon}</Text>
                  <Text style={[st.label, tab === key && { color: C.brand, fontWeight: '700' }]}>{t.tabs[key]}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: '#fff' },
  tab: { flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 22 },
  label: { fontSize: 14, color: C.muted },
});
