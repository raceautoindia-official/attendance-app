import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, Linking, StyleSheet } from 'react-native';
import { colors } from '../theme';
import { API_BASE_URL } from '../config';

// Google Play "prominent disclosure" for location data (required before the
// app may request any location permission). Shown once, before the first
// clock-in; acceptance is stored and can only be satisfied by an explicit tap.
export default function ConsentModal({
  visible,
  onAccept,
  onDecline,
}: {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Location & Data Notice</Text>
          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 8 }}>
            <Text style={styles.text}>
              This app collects your device's <Text style={styles.bold}>precise location</Text> to
              record where you clock in and out, and — <Text style={styles.bold}>only while you are
              clocked in</Text> — continues collecting location in the background (including when the
              app is closed or not in use) so your employer can verify work hours and site presence.
            </Text>
            <Text style={styles.text}>
              • Location is <Text style={styles.bold}>never collected outside your shift</Text> — it
              stops automatically at clock-out.{'\n'}
              • A visible notification is always shown while tracking is active.{'\n'}
              • Your data is visible only to your employer's authorised administrators and is not
              shared with or sold to any third party.{'\n'}
              • Data is transmitted securely (HTTPS) and stored on your employer's server.
            </Text>
            <TouchableOpacity onPress={() => Linking.openURL(`${API_BASE_URL}/privacy`)}>
              <Text style={styles.link}>Read the full Privacy Policy</Text>
            </TouchableOpacity>
          </ScrollView>
          <TouchableOpacity style={styles.accept} onPress={onAccept} activeOpacity={0.85}>
            <Text style={styles.acceptText}>I Agree</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.decline} onPress={onDecline} activeOpacity={0.7}>
            <Text style={styles.declineText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 20, maxHeight: '85%' },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  body: { flexGrow: 0 },
  text: { color: colors.textLabel, fontSize: 14, lineHeight: 21, marginBottom: 12 },
  bold: { fontWeight: '700', color: colors.text },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', marginBottom: 4 },
  accept: { backgroundColor: colors.brand, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  acceptText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  decline: { paddingVertical: 12, alignItems: 'center' },
  declineText: { color: colors.textMuted, fontSize: 14 },
});
