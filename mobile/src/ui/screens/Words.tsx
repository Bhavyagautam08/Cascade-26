// Dukaan ke shabd (Lexicon Drop): teach the worker a word; it works from the very next sentence.
// Ported from frontend/src/views/Words.tsx. Saved in this phone's ledger file (meta "lexicon").
import React, { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { service } from '../../app/service';
import { ledger, useNav } from '../common';
import { Button, C, Card, Empty, ErrorLine, Muted, Pill, Row, Screen, Segmented, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

type Section = 'units' | 'items' | 'aliases' | 'verbs' | 'numbers' | 'prices' | 'perishable';
const SECTIONS: Section[] = ['units', 'items', 'aliases', 'verbs', 'numbers', 'prices', 'perishable'];
const UNIT_KINDS = ['kg', 'l', 'plate', 'packet'];
const VERB_KINDS = ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense', 'order'];

function show(section: Section, v: unknown) {
  if (section === 'units' && v && typeof v === 'object') {
    const u = v as { unit: string; factor: number };
    return `${u.factor} ${u.unit}`;
  }
  if (section === 'verbs') return t.kinds[String(v)] ?? String(v);
  if (section === 'prices') return `₹${v}`;
  return String(v);
}

export function Words() {
  const v = useLedgerVersion();
  const nav = useNav();
  const [section, setSection] = useState<Section>('units');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('kg');
  const [verb, setVerb] = useState('purchase');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lex = useMemo(() => ledger().lexicon.data, [v]);
  const needsNumber = section === 'units' || section === 'numbers' || section === 'prices';
  const entries = lex[section] as Record<string, unknown> | string[] | undefined;
  const list: [string, unknown][] = !entries ? [] : Array.isArray(entries) ? entries.map((k) => [k, null]) : Object.entries(entries);
  const total = Object.values(lex).reduce((n: number, e) => n + (Array.isArray(e) ? e.length : e && typeof e === 'object' ? Object.keys(e).length : 0), 0);

  function add() {
    const k = key.trim().toLowerCase();
    if (!k) return;
    let val: unknown = value.trim();
    if (needsNumber) {
      const n = Number(value);
      if (!value.trim() || isNaN(n)) return setError(t.words.needNumber);
      val = section === 'units' ? { unit, factor: n } : n;
    } else if (section === 'verbs') val = verb;
    else if (section === 'perishable') val = null;
    else if (!value.trim()) return setError(`${t.words.value[section]}?`);
    try {
      ledger().lexicon.add(section, k, val);
      service.changed();
      setFresh(`${section}:${k}`);
      setKey('');
      setValue('');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen title={t.words.title} line={t.words.line(total)} onBack={nav.pop}>
      <Segmented value={section} onChange={(x) => (setSection(x), setKey(''), setValue(''), setError(null))} options={SECTIONS.map((x) => ({ value: x, label: t.words.sections[x] }))} />
      <Card title={t.words.sections[section]}>
        <Muted>{t.words.help[section]}</Muted>
        <Text style={s.small}>{t.words.key[section]}</Text>
        <TextInput style={s.input} value={key} onChangeText={setKey} placeholder={t.words.keyHint[section]} placeholderTextColor={C.faint} autoCapitalize="none" accessibilityLabel={t.words.key[section]} />
        {section === 'verbs' ? (
          <>
            <Text style={s.small}>{t.words.value.verbs}</Text>
            <Segmented value={verb} onChange={setVerb} options={VERB_KINDS.map((k) => ({ value: k, label: t.kinds[k] }))} />
          </>
        ) : section !== 'perishable' ? (
          <>
            <Text style={s.small}>{t.words.value[section]}</Text>
            <TextInput style={s.input} value={value} onChangeText={setValue} placeholder={t.words.valueHint[section]} placeholderTextColor={C.faint} keyboardType={needsNumber ? 'decimal-pad' : 'default'} autoCapitalize="none" accessibilityLabel={t.words.value[section]} />
            {section === 'units' ? <Segmented value={unit} onChange={setUnit} options={UNIT_KINDS.map((u) => ({ value: u, label: u }))} /> : null}
          </>
        ) : null}
        <Button label={t.words.teach} onPress={add} disabled={!key.trim()} />
        <ErrorLine error={error} />
      </Card>
      <Card title={t.words.knows(list.length)}>
        {list.length === 0 ? <Empty>{t.words.none}</Empty> : section === 'perishable' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {list.map(([k]) => <Pill key={k} tone={fresh === `${section}:${k}` ? 'good' : 'muted'}>{k}</Pill>)}
          </View>
        ) : list.map(([k, val]) => (
          <Row key={k} style={fresh === `${section}:${k}` ? { backgroundColor: C.goodSoft } : undefined}>
            <Text style={[s.body, { fontWeight: '700', flex: 1 }]}>{k}</Text>
            <Text style={s.body}>{show(section, val)}</Text>
          </Row>
        ))}
      </Card>
    </Screen>
  );
}
