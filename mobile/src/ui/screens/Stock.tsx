// Stock aur barbaadi: count-to-count periods, the learned recipe, overnight changes, and where the waste
// went. Ported from frontend/src/views/Stock.tsx; computed on the phone from the ledger (inference.ts).
import React, { useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { llm } from '../../app/llm';
import { clipRecorder, MicBlocked } from '../../app/mic';
import { listDays } from '../../core/days';
import { fuse } from '../../core/fusion';
import {
  confirmInventory, INVENTORY_SCHEMA, inventoryFromWords, InventoryWouldOverwrite, inventoryPrompt, inventoryRecordingId,
  parseInventoryAnswer, todayInventory, updateInventoryItem, type InventoryItem, type InventoryMode,
} from '../../core/inventory';
import { attributeLoss, wastageFromLedger } from '../../core/inference';
import { spokenNumbers } from '../../core/rules';
import { fixItemSpelling } from '../../core/spelling';
import type { Event } from '../../core/events';
import { amountText, confirmRemove, itemKey, itemName, kindText, ledger, tryRun, useClip, useNav, what } from '../common';
import { Actions, Body, Button, C, Card, Empty, ErrorLine, Field, Input, KindTag, LevelMeter, MicButton, Muted, Row, Screen, Segmented, Stepper, cap, fmtQty, pct, s, useLedgerVersion } from '../kit';
import { t } from '../strings';
import { worstWaste } from './Today';

const amount = (v: number, unit: string | null) => (unit === 'kg' ? `${Math.round(v * 1000)} g` : unit === 'l' ? `${Math.round(v * 1000)} ml` : `${fmtQty(v)} ${unit ?? ''}`);

export function Stock() {
  useLedgerVersion();
  const L = ledger();
  const all = L.store.all();
  const perishable = L.lexicon.data.perishable ?? [];
  const data = { stock: wastageFromLedger(fuse(all).effective, perishable), days: listDays(all), perishable };
  const names = Object.keys(data.stock.ingredients);
  const [pick, setPick] = useState<string | null>(null);
  const name = pick && names.includes(pick) ? pick : names[0] ?? null;
  const g: any = name ? data.stock.ingredients[name] : null;
  const worst = worstWaste(data.stock.ingredients);
  const dayOf = (i: number) => {
    const d = data.days.find((x) => x.index === i);
    return i === 0 ? t.today.beforeFirstDay : t.today.day(i, d?.date ?? null, !!d?.clock_suspect);
  };
  const line = !names.length ? t.stock.none : worst ? t.stock.worst(cap(worst.what), worst.days) : t.stock.counted(names.join(', '));

  return (
    <Screen title={t.stock.title} line={line}>
      <InventoryEntry />
      {names.length > 1 ? <Segmented value={name ?? ''} onChange={setPick} options={names.map((n) => ({ value: n, label: itemName(n) }))} /> : null}
      {g && name ? (
        <>
          <Card title={t.stock.periodsTitle(cap(itemName(name)))}>
            <Muted>{t.stock.periodsNote}</Muted>
            {g.rows.length === 0 ? <Empty>{t.stock.onlyOne(name)}</Empty> : g.rows.map((r: any, i: number) => (
              <View key={i} style={[s.row, { flexDirection: 'column', alignItems: 'stretch' }]}>
                <Text style={[s.body, { fontWeight: '700' }]}>
                  {dayOf(r.from_day)}{r.to_day !== r.from_day ? ` → ${dayOf(r.to_day)}` : ''} · {t.stock.kinds[r.kind]}
                </Text>
                {r.note ? <Text style={{ color: C.warn }}>{r.note}</Text> : null}
                {r.start_kind === 'stock_count' && r.kind === 'trading' && r.from_day !== r.to_day ? <Muted>{t.stock.noMorning}</Muted> : null}
                <Body>
                  {t.stock.had} {fmtQty(r.start_qty)} + {t.stock.bought} {r.bought ? fmtQty(r.bought) : 0} − {t.stock.left} {fmtQty(r.end_qty)} = {t.stock.used}{' '}
                  <Text style={{ fontWeight: '800' }}>{r.burn == null ? '—' : `${fmtQty(r.burn)} ${g.unit ?? ''}`}</Text>
                </Body>
                {data.stock.dishes.filter((d: string) => r.plates[d]).map((d: string) => <Muted key={d}>{t.stock.plates(d, fmtQty(r.plates[d]))}</Muted>)}
              </View>
            ))}
            {g.status !== 'ok' ? <Muted>{cap(g.status)}.</Muted> : null}
          </Card>

          <Card title={t.stock.recipeTitle}>
            <Muted>{t.stock.recipeNote}</Muted>
            <Recipe stock={data.stock} />
          </Card>

          <Card title={t.stock.overnightTitle}>
            {g.overnight.length === 0 ? <Empty>{t.stock.overnightNone(name)}</Empty> : g.overnight.map((o: any, i: number) => (
              <Row key={i}>
                <Text style={[s.body, { flex: 1 }]}>{dayOf(o.from_day)} → {dayOf(o.to_day)}</Text>
                <Text style={[s.body, { fontWeight: '700' }]}>
                  {o.change > 0 ? t.stock.gone(`${fmtQty(o.change)} ${g.unit}`) : o.change < 0 ? t.stock.more(`${fmtQty(-o.change)} ${g.unit}`) : t.stock.noChange}
                </Text>
              </Row>
            ))}
          </Card>

          <Loss name={name} g={g} spoils={data.perishable.includes(name)} />
        </>
      ) : null}
    </Screen>
  );
}

function InventoryEntry() {
  const L = ledger();
  const all = L.store.all();
  const [mode, setMode] = useState<InventoryMode>(() => (todayInventory(all, 'opening').length ? 'closing' : 'opening'));
  const [text, setText] = useState('');
  const [transcript, setTranscript] = useState('');
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [byRules, setByRules] = useState(false);
  const [overwrite, setOverwrite] = useState<Event[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [saved, setSaved] = useState<{ duplicate: boolean; count: number } | null>(null);
  const clip = useClip();
  const counts = todayInventory(all, mode);
  const morning = mode === 'opening';

  async function startRecording() {
    setError(null);
    setSaved(null);
    try {
      await clipRecorder.start();
      setBlocked(false);
    } catch (e) {
      setBlocked(e instanceof MicBlocked);
      setError((e as Error).message);
    }
  }

  async function stopAndRead() {
    setBusy(true);
    setError(null);
    try {
      const voiceText = await clipRecorder.stopAndRead(L);
      const said = text.trim() ? `${text.trim()}\n${voiceText}` : voiceText;
      setText(said);
      await read(said);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function read(source = text.trim()) {
    if (!source) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      let parsed: InventoryItem[];
      // the model reads it when it is running; otherwise the word rules do, at once (CPU model: minutes)
      if (llm.status.state === 'ready') {
        const normalized = spokenNumbers(fixItemSpelling(source, L.lexicon.data).text, L.lexicon.data);
        const answer = await llm.json(inventoryPrompt(L.lexicon.data, mode), `text: ${normalized}`, INVENTORY_SCHEMA, 1536);
        parsed = parseInventoryAnswer(answer, source, L.lexicon.data, mode);
        setByRules(false);
      } else {
        parsed = inventoryFromWords(source, L.lexicon.data, mode);
        setByRules(true);
      }
      setTranscript(source);
      setItems(parsed);
      setOverwrite(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function edit(index: number, changes: Partial<Pick<InventoryItem, 'item' | 'qty' | 'unit' | 'total_cost' | 'status'>>) {
    setItems((current) => current?.map((item, i) => i === index ? updateInventoryItem(item, changes, mode) : item) ?? null);
  }

  function save(replace: boolean) {
    if (!items) return;
    setError(null);
    try {
      const keyed = items.map((item) => ({ ...item, item: itemKey(item.item) ?? item.item })); // "tamatar" -> "tomato"
      const result = confirmInventory(L, inventoryRecordingId(transcript, mode), transcript, keyed, mode, replace);
      setSaved({ duplicate: result.duplicate, count: result.events.length });
      setItems(null);
      setTranscript('');
      setText('');
      setOverwrite(null);
    } catch (e) {
      if (e instanceof InventoryWouldOverwrite) setOverwrite(e.existing);
      else setError((e as Error).message);
    }
  }

  const editNumber = (index: number, field: 'qty' | 'total_cost', value: string) => {
    if (!value.trim()) return edit(index, { [field]: null });
    const number = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(number) || number < 0) {
      setError(t.stock.invalidNumber);
      return;
    }
    setError(null);
    edit(index, { [field]: number });
  };
  const openQuestions = items?.filter((item) => item.question).length ?? 0;

  return (
    <>
    <Card title={t.stock.inventoryTitle} tone={overwrite ? 'warn' : undefined}>
      <Segmented value={mode} onChange={(value) => {
        setMode(value);
        setItems(null);
        setTranscript('');
        setOverwrite(null);
        setSaved(null);
        setError(null);
      }} options={[
        { value: 'opening', label: `🌅 ${t.stock.morning}` },
        { value: 'closing', label: `🌙 ${t.stock.evening}` },
      ]} />
      <Muted>{t.stock.voiceNote}</Muted>
      <MicButton
        on={clip.active}
        busy={busy}
        disabled={!!items}
        onPress={clip.active ? stopAndRead : startRecording}
        label={clip.active ? t.stock.voiceStop(Math.floor(clip.seconds)) : busy ? t.stock.voiceReading : t.stock.voiceStart}
      />
      {clip.active ? (
        <>
          <LevelMeter level={clip.level} on />
          <Button small kind="plain" label={t.cancel} onPress={() => void clipRecorder.cancel()} />
        </>
      ) : null}
      {blocked ? <Button kind="warn" label={t.mic.openSettings} onPress={() => void Linking.openSettings()} /> : null}
      <ErrorLine error={error} />

      {!items ? (
        <>
          <Text style={s.label}>{t.stock.typeInstead}</Text>
          <Input
            style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 12 }}
            multiline
            editable={!busy && !clip.active}
            value={text}
            onChangeText={setText}
            placeholder={morning ? t.stock.morningExample : t.stock.eveningExample}
            accessibilityLabel={t.stock.inventoryTitle}
          />
          <Button label={busy ? t.stock.reading : t.stock.readInventory} onPress={() => void read()} disabled={busy || clip.active || !text.trim()} />
        </>
      ) : null}

      {saved ? <Body style={{ color: C.good, fontWeight: '700' }}>{saved.duplicate ? t.stock.inventoryDuplicate : `✓ ${t.stock.inventorySaved(saved.count)}`}</Body> : null}

      {items ? (
        <View style={{ gap: 10, paddingTop: 8 }}>
          <Muted>{t.stock.heard(transcript)}</Muted>
          {byRules ? <Text style={[s.small, { color: C.warn }]}>{t.stock.readRules}</Text> : null}
          {items.length === 0 ? <Empty>{t.stock.noItems}</Empty> : items.map((item, index) => (
            <View key={`${index}-${item.said}`} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10, gap: 6 }}>
              <Field label={t.stock.item}><Input value={itemName(item.item)} onChangeText={(value) => edit(index, { item: value })} placeholder={t.stock.item} /></Field>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field label={morning ? t.stock.quantity : t.stock.leftQty}>
                  <Input value={item.qty === null ? '' : String(item.qty)} onChangeText={(value) => editNumber(index, 'qty', value)} keyboardType="decimal-pad" placeholder="?" />
                </Field>
                <Field label={t.stock.unit}>
                  <Input value={item.unit ?? ''} onChangeText={(value) => edit(index, { unit: value || null })} placeholder="kg" />
                </Field>
                {morning ? (
                  <Field label={t.stock.cost}>
                    <Input value={item.total_cost === null ? '' : String(item.total_cost)} onChangeText={(value) => editNumber(index, 'total_cost', value)} keyboardType="decimal-pad" placeholder="₹" />
                  </Field>
                ) : null}
              </View>
              {morning ? (
                <Segmented value={item.status === 'purchased' ? 'purchased' : item.status === 'opening' ? 'opening' : 'unclear'} onChange={(value) => {
                  if (value !== 'unclear') edit(index, { status: value });
                }} options={[
                  { value: 'opening', label: t.stock.alreadyHad },
                  { value: 'purchased', label: t.stock.boughtToday },
                ]} />
              ) : null}
              {item.question ? <Text style={[s.body, { color: C.warn, fontWeight: '700' }]}>❓ {item.question}</Text> : null}
              <Button small kind="plain" icon="🗑" label={t.stock.removeItem} onPress={() => setItems((current) => current?.filter((_, i) => i !== index) ?? null)} />
            </View>
          ))}
          {morning && items.length ? <Muted>{t.stock.totalCost(items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0))}</Muted> : null}
          {openQuestions ? <Text style={[s.body, { color: C.warn }]}>{t.stock.openQuestions(openQuestions)}</Text> : null}
          {overwrite ? (
            <View style={{ gap: 6 }}>
              <Text style={[s.body, { color: C.warn }]}>{t.stock.overwriteQuestion(overwrite.map((event) => `${itemName(event.payload.item)} ${event.payload.qty ?? ''} ${event.payload.unit ?? ''}`).join(', '))}</Text>
              <Button label={t.stock.replaceCounts} onPress={() => save(true)} disabled={busy || openQuestions > 0 || items.length === 0} />
              <Button kind="plain" label={t.stock.keepCounts} onPress={() => setOverwrite(null)} disabled={busy} />
            </View>
          ) : (
            <>
              <Button icon="✓" label={t.stock.saveInventory} onPress={() => save(false)} disabled={busy || openQuestions > 0 || items.length === 0} />
              <Button kind="plain" label={t.stock.discardInventory} onPress={() => { setItems(null); setTranscript(''); setError(null); }} disabled={busy} />
            </>
          )}
        </View>
      ) : null}
    </Card>

    <Card title={t.stock.countsTitle(morning)}>
      {counts.length ? <Muted>{t.stock.countsNote}</Muted> : <Empty>{morning ? t.stock.noMorningCount : t.stock.noEveningCount}</Empty>}
      {counts.map((event) => <SavedCount key={event.id} e={event} />)}
    </Card>
    </>
  );
}

/** One saved stock line: change its quantity in place, or withdraw it (both are ledger entries). */
function SavedCount({ e }: { e: Event }) {
  const nav = useNav();
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(e.payload.qty ?? ''));
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={[s.row, { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KindTag kind={e.kind} label={kindText(e)} />
        <Text style={[s.body, { flex: 1, fontWeight: '700' }]}>{what(e)}</Text>
        <Text style={s.body}>{amountText(e)}</Text>
      </View>
      {editing ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Input style={{ flex: 1 }} value={qty} onChangeText={setQty} keyboardType="decimal-pad" placeholder={t.stock.newQty} accessibilityLabel={t.stock.newQty} />
          <Button small label={t.entry.save} onPress={() => tryRun(() => {
            const n = Number(qty.replace(/,/g, ''));
            if (!qty.trim() || !Number.isFinite(n) || n < 0) throw new Error(t.stock.invalidNumber);
            ledger().correct(e.id, { qty: n });
            setEditing(false);
          }, setError)} />
        </View>
      ) : null}
      <Actions>
        <Button small kind="soft" icon="✎" label={t.review.edit} onPress={() => setEditing((x) => !x)} />
        <Button small kind="plain" label={t.open} onPress={() => nav.push({ name: 'entry', id: e.id, edit: true })} />
        <Button small kind="plain" icon="🗑" label={t.review.remove} onPress={() => confirmRemove(e, setError)} />
      </Actions>
      <ErrorLine error={error} />
    </View>
  );
}

function Recipe({ stock }: { stock: ReturnType<typeof wastageFromLedger> }) {
  const learned = Object.entries(stock.ingredients).filter(([, g]: any) => g.status === 'ok' && g.usage_per_dish) as [string, any][];
  if (!learned.length) return <Empty>{t.stock.recipeNone}</Empty>;
  return (
    <>
      {stock.dishes.map((dish) => {
        const parts = learned.map(([n, g]) => ({ n, v: g.usage_per_dish[dish] ?? 0, unit: g.unit })).filter((p) => p.v > 0.0005).map((p) => `${amount(p.v, p.unit)} ${p.n}`);
        return (
          <Row key={dish}>
            <Text style={[s.body, { fontWeight: '700' }]}>{t.stock.perPlate(dish)}</Text>
            <Text style={[s.body, { flex: 1, textAlign: 'right' }]}>{parts.join(' + ') || t.stock.nothingMeasurable}</Text>
          </Row>
        );
      })}
      <Muted>{t.stock.steady(learned.map(([n, g]) => `${amount(g.baseline_waste_per_period ?? 0, g.unit)} ${n}`).join(' · '))}</Muted>
    </>
  );
}

const CAUSE_COLORS = ['#B3261E', '#2F5DA8', '#A35400'];

function Loss({ name, g, spoils }: { name: string; g: any; spoils: boolean }) {
  const [temp, setTemp] = useState(32);
  const [away, setAway] = useState(0);
  const [family, setFamily] = useState(0);
  const kg = g.unexplained ?? 0;
  const loss = useMemo(
    () => (g.status === 'ok' ? attributeLoss(kg, { temperature_c: temp, unattended_hours: away, family_present: family, perishable: spoils }) : null),
    [g.status, kg, temp, away, family, spoils],
  );
  return (
    <Card title={t.stock.lossTitle}>
      <Muted>{t.stock.lossNote}</Muted>
      {!loss ? <Empty>{t.stock.lossNone(name)}</Empty> : (
        <>
          <Body style={{ fontWeight: '700' }}>{t.stock.lossTotal(`${fmtQty(kg)} ${g.unit}`, name, spoils)}</Body>
          <Stepper label={t.stock.temp} value={temp} min={15} max={48} unit="°C" onChange={setTemp} />
          <Stepper label={t.stock.away} value={away} min={0} max={10} unit={t.stock.hours} onChange={setAway} />
          <Stepper label={t.stock.family} value={family} min={0} max={6} unit={t.stock.people} onChange={setFamily} />
          <View style={{ flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden', marginTop: 6 }} accessibilityLabel={(['spoilage', 'theft', 'personal'] as const).map((k) => `${t.stock.causes[k]} ${pct(loss.split[k].p)}`).join(', ')}>
            {(['spoilage', 'theft', 'personal'] as const).map((k, i) => <View key={k} style={{ flex: loss.split[k].p, backgroundColor: CAUSE_COLORS[i] }} />)}
          </View>
          {(['spoilage', 'theft', 'personal'] as const).map((k, i) => (
            <Row key={k}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: CAUSE_COLORS[i] }} />
                <Text style={s.body}>{t.stock.causes[k]}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.body, { fontWeight: '800' }]}>{pct(loss.split[k].p)} · {fmtQty(loss.split[k].kg)} {g.unit}</Text>
                <Text style={s.small}>{t.stock.between(pct(loss.split[k].p10), pct(loss.split[k].p90))}</Text>
              </View>
            </Row>
          ))}
          {loss.reasons.length ? loss.reasons.map((r) => <Muted key={r}>• {cap(r)}</Muted>) : <Muted>{t.stock.usual}</Muted>}
        </>
      )}
    </Card>
  );
}
