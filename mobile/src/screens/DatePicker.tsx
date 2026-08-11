import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme';

// ---------------------------------------------------------------------------
// A small calendar, because "Date (YYYY-MM-DD)" as a text field is a form only
// a programmer could love. Deliberately dependency-free: a native date-picker
// module would be nicer still, but it adds a build-time native dependency to
// an app whose releases have to stay boring — and a month grid is 100 lines.
//
// The maths is plain year/month/day arithmetic on strings. The calendar lays
// out a month; it does not know or care what time it is anywhere.
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function pad(n: number): string { return String(n).padStart(2, '0'); }
function toYmd(y: number, m: number, d: number): string { return `${y}-${pad(m + 1)}-${pad(d)}`; }

interface Props {
  visible: boolean;
  /** Currently selected date, YYYY-MM-DD. */
  value: string;
  /** Earliest selectable date, YYYY-MM-DD (older days render disabled). */
  minYmd?: string;
  onPick: (ymd: string) => void;
  onClose: () => void;
}

export default function DatePicker({ visible, value, minYmd, onPick, onClose }: Props) {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const initY = parsed ? Number(parsed[1]) : new Date().getFullYear();
  const initM = parsed ? Number(parsed[2]) - 1 : new Date().getMonth();
  const [viewY, setViewY] = useState(initY);
  const [viewM, setViewM] = useState(initM);

  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const firstWeekday = new Date(viewY, viewM, 1).getDay(); // Sun = 0
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const move = (delta: number) => {
    const next = new Date(viewY, viewM + delta, 1);
    setViewY(next.getFullYear());
    setViewM(next.getMonth());
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.navBtn} onPress={() => move(-1)}>
              <Text style={styles.navText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.monthLabel}>{MONTHS[viewM]} {viewY}</Text>
            <TouchableOpacity style={styles.navBtn} onPress={() => move(1)}>
              <Text style={styles.navText}>›</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {WEEKDAYS.map((w, i) => (
              <Text key={i} style={styles.weekday}>{w}</Text>
            ))}
          </View>

          <View style={styles.grid}>
            {cells.map((day, i) => {
              if (day == null) return <View key={i} style={styles.cell} />;
              const ymd = toYmd(viewY, viewM, day);
              const disabled = !!minYmd && ymd < minYmd;
              const selected = ymd === value;
              return (
                <TouchableOpacity
                  key={i}
                  style={[styles.cell, selected && styles.cellSelected]}
                  disabled={disabled}
                  onPress={() => { onPick(ymd); onClose(); }}
                >
                  <Text style={[styles.cellText, disabled && styles.cellTextDisabled, selected && styles.cellTextSelected]}>
                    {day}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.footer}>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 28 },
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn: { paddingHorizontal: 14, paddingVertical: 4 },
  navText: { color: colors.accent, fontSize: 24, fontWeight: '700' },
  monthLabel: { color: colors.text, fontSize: 16, fontWeight: '700' },
  weekRow: { flexDirection: 'row', marginBottom: 4 },
  weekday: { flex: 1, textAlign: 'center', color: colors.textFaint, fontSize: 12, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`, aspectRatio: 1.15,
    alignItems: 'center', justifyContent: 'center', borderRadius: 8,
  },
  cellSelected: { backgroundColor: colors.brand },
  cellText: { color: colors.textLabel, fontSize: 14 },
  cellTextDisabled: { color: colors.borderInput },
  cellTextSelected: { color: '#ffffff', fontWeight: '700' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  cancelText: { color: colors.textMuted, fontSize: 14, fontWeight: '600', padding: 6 },
});
