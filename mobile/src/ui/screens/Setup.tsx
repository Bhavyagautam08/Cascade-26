// First launch: this phone's name and the family key (with an eye to read it back before saving).
import React, { useState } from 'react';
import { service } from '../../app/service';
import { tryRun } from '../common';
import { Button, Card, ErrorLine, Field, Input, Muted, Screen } from '../kit';
import { t } from '../strings';

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('phone-1');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen title={t.setup.title} line={t.setup.line}>
      <Card>
        <Field label={t.setup.name}><Input value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t.setup.name} /></Field>
        <Field label={t.setup.key}><Input secret value={key} onChangeText={setKey} accessibilityLabel={t.setup.key} /></Field>
        <Muted>{t.setup.keyHint}</Muted>
        <Button kind="soft" icon="🔑" label={t.setup.newKey} onPress={() => setKey(Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join(''))} />
      </Card>
      <ErrorLine error={error} />
      <Button label={t.setup.save} onPress={() => tryRun(() => { service.open(name.trim(), key.trim()); onDone(); }, setError)} />
    </Screen>
  );
}
