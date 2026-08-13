import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme';

// ---------------------------------------------------------------------------
// A clock face, because typing "2:30" and then hunting for an AM/PM toggle is
// not how anyone sets a time on a phone. This is the alarm-clock method: tap
// the hour on the dial, then tap the minute.
//
// Dependency-free, for the same reason as DatePicker: a native picker module
// would be nicer still, but it adds a build-time native dependency to an app
// whose releases have to stay boring. A dial is arithmetic and absolute
// positioning.
//
// It speaks 24-hour "HH:MM" to the outside world and 12-hour with AM/PM to the
// person, which is the split the rest of the app already uses — staff think
// "2:30 pm", the server stores 14:30.
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean;
  /** Current value as 24-hour "HH:MM". Empty opens at a sensible default. */
  value: string;
  /** Shown above the dial: "From" / "To". */
  title?: string;
  /** Called with 24-hour "HH:MM". */
  onPick: (hhmm: string) => void;
  onClose: () => void;
}

const DIAL_SIZE = 260;
const RADIUS = DIAL_SIZE / 2 - 26;
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** Minutes land on fives — the granularity a permission is ever asked in. */
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** Where the i-th of 12 positions sits, 12 o'clock at the top. */
function seat(i: number): { left: number; top: number } {
  const angle = (i / 12) * 2 * Math.PI - Math.PI / 2;
  return {
    left: DIAL_SIZE / 2 + RADIUS * Math.cos(angle) - 20,
    top: DIAL_SIZE / 2 + RADIUS * Math.sin(angle) - 20,
  };
}

export default function TimePicker({ visible, value, title, onPick, onClose }: Props) {
  const parsed = /^(\d{2}):(\d{2})$/.exec(value ?? '');
  const initH24 = parsed ? Number(parsed[1]) : 10;
  const initMin = parsed ? Number(parsed[2]) : 0;

  const [hour12, setHour12] = useState(initH24 % 12 === 0 ? 12 : initH24 % 12);
  const [minute, setMinute] = useState(initMin);
  const [ampm, setAmPm] = useState<'AM' | 'PM'>(initH24 >= 12 ? 'PM' : 'AM');
  /** Which half of the dial is being set. Tapping an hour advances to minutes,
   *  the way every alarm clock does — one gesture fewer than a mode switch. */
  const [mode, setMode] = useState<'hour' | 'minute'>('hour');

  // Reopening for a different field must not show the previous field's time.
  useEffect(() => {
    if (!visible) return;
    const p = /^(\d{2}):(\d{2})$/.exec(value ?? '');
    const h = p ? Number(p[1]) : 10;
    const m = p ? Number(p[2]) : 0;
    setHour12(h % 12 === 0 ? 12 : h % 12);
    setMinute(m);
    setAmPm(h >= 12 ? 'PM' : 'AM');
    setMode('hour');
  }, [visible, value]);

  const confirm = () => {
    let h = hour12 % 12;
    if (ampm === 'PM') h += 12;
    onPick(`${pad(h)}:${pad(minute)}`);
    onClose();
  };

  const numbers = mode === 'hour' ? HOURS : MINUTES;
  const selected = mode === 'hour' ? hour12 : minute;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {!!title && <Text style={styles.title}>{title}</Text>}

          {/* The reading, and the way to go back to the hour after the dial has
              moved on to minutes. */}
          <View style={styles.readout}>
            <TouchableOpacity onPress={() => setMode('hour')}>
              <Text style={[styles.readNum, mode === 'hour' && styles.readNumOn]}>{hour12}</Text>
            </TouchableOpacity>
            <Text style={styles.readColon}>:</Text>
            <TouchableOpacity onPress={() => setMode('minute')}>
              <Text style={[styles.readNum, mode === 'minute' && styles.readNumOn]}>{pad(minute)}</Text>
            </TouchableOpacity>
            <View style={styles.ampmCol}>
              {(['AM', 'PM'] as const).map(ap => (
                <TouchableOpacity
                  key={ap}
                  style={[styles.ampmBtn, ampm === ap && styles.ampmBtnOn]}
                  onPress={() => setAmPm(ap)}
                >
                  <Text style={[styles.ampmText, ampm === ap && styles.ampmTextOn]}>{ap}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Text style={styles.hint}>
            {mode === 'hour' ? 'Tap the hour' : 'Tap the minutes'}
          </Text>

          <View style={styles.dial}>
            <View style={styles.dialCentre} />
            {numbers.map((n, i) => {
              const pos = seat(i);
              const on = n === selected;
              return (
                <TouchableOpacity
                  key={n}
                  style={[styles.seat, { left: pos.left, top: pos.top }, on && styles.seatOn]}
                  onPress={() => {
                    if (mode === 'hour') {
                      setHour12(n);
                      setMode('minute');   // straight on to the minutes
                    } else {
                      setMinute(n);
                    }
                  }}
                >
                  <Text style={[styles.seatText, on && styles.seatTextOn]}>
                    {mode === 'hour' ? n : pad(n)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.action} onPress={onClose}>
              <Text style={styles.actionText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.action, styles.actionOn]} onPress={confirm}>
              <Text style={[styles.actionText, styles.actionTextOn]}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 16, padding: 18,
    borderWidth: 1, borderColor: colors.border, width: '100%', maxWidth: 340,
  },
  title: { color: colors.textMuted, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  readout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  readNum: { color: colors.textMuted, fontSize: 40, fontWeight: '700', paddingHorizontal: 4 },
  readNumOn: { color: colors.brand },
  readColon: { color: colors.textMuted, fontSize: 40, fontWeight: '700' },
  ampmCol: { marginLeft: 12 },
  ampmBtn: {
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8,
    borderWidth: 1, borderColor: colors.border, marginVertical: 2,
  },
  ampmBtnOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  ampmText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  ampmTextOn: { color: '#ffffff' },
  hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginBottom: 8 },
  dial: {
    width: DIAL_SIZE, height: DIAL_SIZE, alignSelf: 'center',
    borderRadius: DIAL_SIZE / 2, backgroundColor: colors.bg,
    borderWidth: 1, borderColor: colors.border, marginBottom: 14,
  },
  dialCentre: {
    position: 'absolute', left: DIAL_SIZE / 2 - 3, top: DIAL_SIZE / 2 - 3,
    width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textFaint,
  },
  seat: {
    position: 'absolute', width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  seatOn: { backgroundColor: colors.brand },
  seatText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  seatTextOn: { color: '#ffffff', fontWeight: '800' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  action: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 10 },
  actionOn: { backgroundColor: colors.brand },
  actionText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  actionTextOn: { color: '#ffffff' },
});
