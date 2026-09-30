import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { calculateHaversineDistanceKm } from '../utils/haversine';
import { triggerAlarmNotification } from './notificationService';
import { playContinuousAlarm } from './audioService';

export const LOCATION_TASK_NAME = 'BACKGROUND_LOCATION_WAKE_UP_TASK';

export const STORAGE_KEYS = {
  TARGET_LAT: '@wake_me_up_target_lat',
  TARGET_LON: '@wake_me_up_target_lon',
  TARGET_RADIUS: '@wake_me_up_target_radius_km',
  TARGET_NAME: '@wake_me_up_target_name',
  IS_ALARM_TRIGGERED: '@wake_me_up_alarm_triggered',
  CURRENT_DISTANCE: '@wake_me_up_current_distance',
  TRACKING_ACTIVE: '@wake_me_up_tracking_active',
  CURRENT_LAT: '@wake_me_up_current_lat',
  CURRENT_LON: '@wake_me_up_current_lon',
  CURRENT_SPEED: '@wake_me_up_current_speed',
  CUSTOM_ALARM_URI: '@wake_me_up_custom_alarm_uri',
  CUSTOM_ALARM_NAME: '@wake_me_up_custom_alarm_name',
};

interface LocationTaskData {
  locations?: Location.LocationObject[];
}

/**
 * Task pelacakan lokasi latar belakang (Background Worker).
 * Berjalan independen dari lifecycle React saat aplikasi di-minimize atau layar mati.
 */
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error(`[${LOCATION_TASK_NAME}] Kesalahan task latar belakang:`, error.message);
    return;
  }

  if (!data) return;

  const { locations } = data as LocationTaskData;
  if (!locations || locations.length === 0) return;

  const latestLocation = locations[locations.length - 1].coords;

  try {
    // 1. Simpan koordinat dan kecepatan real-time
    const currentSpeedKmh =
      latestLocation.speed !== null && latestLocation.speed !== undefined && latestLocation.speed > 0
        ? (latestLocation.speed * 3.6).toFixed(1)
        : '0';

    await AsyncStorage.multiSet([
      [STORAGE_KEYS.CURRENT_LAT, latestLocation.latitude.toString()],
      [STORAGE_KEYS.CURRENT_LON, latestLocation.longitude.toString()],
      [STORAGE_KEYS.CURRENT_SPEED, currentSpeedKmh],
    ]);

    // 2. Baca parameter tujuan dan status alarm
    const [targetLatVal, targetLonVal, radiusVal, isTriggeredVal] =
      await AsyncStorage.multiGet([
        STORAGE_KEYS.TARGET_LAT,
        STORAGE_KEYS.TARGET_LON,
        STORAGE_KEYS.TARGET_RADIUS,
        STORAGE_KEYS.IS_ALARM_TRIGGERED,
      ]);

    const targetLat = targetLatVal[1] ? parseFloat(targetLatVal[1]) : null;
    const targetLon = targetLonVal[1] ? parseFloat(targetLonVal[1]) : null;
    const radiusKm = radiusVal[1] ? parseFloat(radiusVal[1]) : null;
    const isTriggered = isTriggeredVal[1] === 'true';

    if (targetLat === null || targetLon === null || radiusKm === null) {
      return;
    }

    // 3. Hitung jarak terkini menggunakan rumus Haversine
    const distanceKm = calculateHaversineDistanceKm(
      latestLocation.latitude,
      latestLocation.longitude,
      targetLat,
      targetLon
    );

    // Simpan sisa jarak untuk ditampilkan di UI
    await AsyncStorage.setItem(
      STORAGE_KEYS.CURRENT_DISTANCE,
      distanceKm.toFixed(2)
    );

    console.log(
      `[WakeMeUp Latar Belakang] Sisa Jarak: ${distanceKm.toFixed(2)} km | Radius Bangun: ${radiusKm} km | Kec: ${currentSpeedKmh} km/jam`
    );

    // 4. Jika jarak <= radius bangun dan alarm belum berdering
    if (distanceKm <= radiusKm && !isTriggered) {
      await AsyncStorage.setItem(STORAGE_KEYS.IS_ALARM_TRIGGERED, 'true');
      await triggerAlarmNotification(distanceKm);
      await playContinuousAlarm();
    }
  } catch (err) {
    console.error(`[${LOCATION_TASK_NAME}] Gagal memproses update lokasi:`, err);
  }
});
