// First launch: this phone's name and the family key.
import React, { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { service } from '../../app/service';
import { tryRun } from '../common';
import { Button, C, Card, ErrorLine, Muted, Screen, s } from '../kit';
import { t } from '../strings';

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('phone-1');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen title={t.setup.title} line={t.setup.line}>
      <Card>
        <Text style={s.body}>{t.setup.name}</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t.setup.name} />
        <Text style={s.body}>{t.setup.key}</Text>
        <TextInput style={s.input} value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.faint} accessibilityLabel={t.setup.key} />
        <Muted>{t.setup.keyHint}</Muted>
        <Button kind="plain" label={t.setup.newKey} onPress={() => setKey(Array.from({ length: 12 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join(''))} />
      </Card>
      <ErrorLine error={error} />
      <Button label={t.setup.save} onPress={() => tryRun(() => { service.open(name.trim(), key.trim()); onDone(); }, setError)} />
    </Screen>
  );
}
