// Aur: the less frequent screens (all entries, the full khaata, shop words, family phones).
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { service } from '../../app/service';
import { ledger, useNav, type Page } from '../common';
import { Button, C, Card, ErrorLine, Muted, Screen, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

export function More() {
  const v = useLedgerVersion();
  const [error, setError] = useState<string | null>(null);
  const nav = useNav();
  const sum = useMemo(() => ledger().summary(), [v]);
  const decisions = sum.conflicts.length + sum.possible_duplicates.length;
  const items: { page: Page; icon: string; title: string; note: string; badge?: number }[] = [
    { page: { name: 'entries' }, icon: '📜', title: t.more.entries, note: t.more.entriesNote },
    { page: { name: 'books' }, icon: '⚖️', title: t.more.books, note: t.more.booksNote, badge: decisions },
    { page: { name: 'words' }, icon: '🗣️', title: t.more.words, note: t.more.wordsNote },
    { page: { name: 'family' }, icon: '📱', title: t.more.family, note: t.more.familyNote },
    { page: { name: 'diagnose' }, icon: '🩺', title: 'Phone ki technical jaanch', note: 'Model aur awaaz ki speed naapo (technical)' },
  ];
  return (
    <Screen title={t.more.title}>
      {items.map((it) => (
        <Pressable key={it.page.name} onPress={() => nav.push(it.page)} accessibilityRole="button" accessibilityLabel={it.title}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <Text style={{ fontSize: 30 }}>{it.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[s.body, { fontWeight: '800', fontSize: 19 }]}>{it.title}</Text>
                <Text style={s.muted}>{it.note}</Text>
              </View>
              {it.badge ? <Text style={{ backgroundColor: C.warn, color: '#fff', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 2, fontWeight: '800', overflow: 'hidden' }}>{it.badge}</Text> : null}
              <Text style={{ color: C.faint, fontSize: 26 }}>›</Text>
            </View>
          </Card>
        </Pressable>
      ))}
      <Card title={t.more.resetTitle} tone="bad">
        <Muted>{t.more.resetNote}</Muted>
        <Button kind="danger" icon="🗑" label={t.more.reset} onPress={() => Alert.alert(t.more.reset, t.more.resetConfirm, [
          { text: t.today.no, style: 'cancel' },
          { text: t.more.reset, style: 'destructive', onPress: () => service.reset().catch((e) => setError((e as Error).message)) },
        ])} />
        <ErrorLine error={error} />
      </Card>
    </Screen>
  );
}
