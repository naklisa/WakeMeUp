import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

export const ALARM_NOTIFICATION_CHANNEL_ID = 'wake-up-alarm-channel';

let Notifications: typeof import('expo-notifications') | null = null;

// Hanya import expo-notifications jika bukan di Expo Go (menghindari crash SDK 53+ di Android)
if (!isRunningInExpoGo()) {
  try {
    Notifications = require('expo-notifications');
    Notifications?.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
        priority: Notifications!.AndroidNotificationPriority.MAX,
      }),
    });
  } catch (e) {
    console.warn('[NotificationService] Gagal memuat expo-notifications:', e);
  }
}

/**
 * Menyiapkan channel notifikasi prioritas tinggi untuk Android (heads-up pop-up).
 */
export async function setupNotificationChannel(): Promise<void> {
  if (isRunningInExpoGo() || !Notifications) {
    return;
  }
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(ALARM_NOTIFICATION_CHANNEL_ID, {
        name: 'Alarm Bangun Tidur',
        description: 'Peringatan keras saat mendekati radius tujuan perjalanan Anda',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500, 250, 1000],
        lightColor: '#EF4444',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
        sound: 'default',
      });
    } catch (e) {
      console.warn('[NotificationService] Gagal membuat channel notifikasi:', e);
    }
  }
}

/**
 * Memicu notifikasi darurat prioritas maksimal untuk membangunkan layar HP.
 */
export async function triggerAlarmNotification(distanceKm: number): Promise<void> {
  if (isRunningInExpoGo() || !Notifications) {
    console.log(
      `[WakeMeUp Expo Go] Notifikasi simulasi: ${distanceKm.toFixed(2)} km lagi sampai tujuan!`
    );
    return;
  }
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '🚨 BANGUN! SUDAH DEKAT TUJUAN!',
        body: `Kamu sudah berada sekitar ${distanceKm.toFixed(2)} km dari tujuan perjalananmu!`,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: '#EF4444',
        data: { type: 'ALARM_TRIGGERED' },
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[NotificationService] Gagal memicu notifikasi:', e);
  }
}

/**
 * Meminta izin notifikasi dengan aman
 */
export async function requestNotificationPermissionSafely(): Promise<boolean> {
  if (isRunningInExpoGo() || !Notifications) {
    return true;
  }
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return true;
  }
}
