import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

export const ALARM_NOTIFICATION_CHANNEL_ID = 'wake-up-alarm-channel';

let Notifications: typeof import('expo-notifications') | null = null;

// Only load expo-notifications when NOT in Expo Go (to avoid SDK 53+ Android crash)
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
    console.warn('[NotificationService] Could not load expo-notifications:', e);
  }
}

/**
 * Creates high-priority notification channel for Android (heads-up notification).
 */
export async function setupNotificationChannel(): Promise<void> {
  if (isRunningInExpoGo() || !Notifications) {
    return;
  }
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(ALARM_NOTIFICATION_CHANNEL_ID, {
        name: 'Wake Up Alarm',
        description: 'Loud alert triggered when you are within your destination radius',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500, 250, 1000],
        lightColor: '#EF4444',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
        sound: 'default',
      });
    } catch (e) {
      console.warn('[NotificationService] Error creating channel:', e);
    }
  }
}

/**
 * Triggers an immediate maximum priority notification to wake the screen.
 */
export async function triggerAlarmNotification(distanceKm: number): Promise<void> {
  if (isRunningInExpoGo() || !Notifications) {
    console.log(
      `[WakeMeUp Expo Go] Notification simulated: ${distanceKm.toFixed(2)} km to destination!`
    );
    return;
  }
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '🚨 WAKE UP! You are near your stop!',
        body: `You are approximately ${distanceKm.toFixed(2)} km from your destination!`,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: '#EF4444',
        data: { type: 'ALARM_TRIGGERED' },
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[NotificationService] Error triggering notification:', e);
  }
}

/**
 * Safely requests notification permissions
 */
export async function requestNotificationPermissionSafely(): Promise<boolean> {
  if (isRunningInExpoGo() || !Notifications) {
    return true; // Skip in Expo Go
  }
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return true;
  }
}
