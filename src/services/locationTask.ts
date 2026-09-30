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
  IS_ALARM_TRIGGERED: '@wake_me_up_alarm_triggered',
  CURRENT_DISTANCE: '@wake_me_up_current_distance',
  TRACKING_ACTIVE: '@wake_me_up_tracking_active',
  CURRENT_LAT: '@wake_me_up_current_lat',
  CURRENT_LON: '@wake_me_up_current_lon',
};

interface LocationTaskData {
  locations?: Location.LocationObject[];
}

/**
 * Top-level background task registration.
 * Defined outside the React component lifecycle so headless background workers can run it.
 */
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error(`[${LOCATION_TASK_NAME}] Task execution error:`, error.message);
    return;
  }

  if (!data) return;

  const { locations } = data as LocationTaskData;
  if (!locations || locations.length === 0) return;

  const latestLocation = locations[locations.length - 1].coords;

  try {
    // 1. Read destination and alarm state from AsyncStorage
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

    // Save live user coordinates for UI
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.CURRENT_LAT, latestLocation.latitude.toString()],
      [STORAGE_KEYS.CURRENT_LON, latestLocation.longitude.toString()],
    ]);

    if (targetLat === null || targetLon === null || radiusKm === null) {
      return;
    }

    // 2. Compute Haversine distance
    const distanceKm = calculateHaversineDistanceKm(
      latestLocation.latitude,
      latestLocation.longitude,
      targetLat,
      targetLon
    );

    // Save live distance for UI
    await AsyncStorage.setItem(
      STORAGE_KEYS.CURRENT_DISTANCE,
      distanceKm.toFixed(2)
    );

    console.log(
      `[WakeMeUp Background] Live Distance: ${distanceKm.toFixed(2)} km | Target Radius: ${radiusKm} km`
    );

    // 3. Trigger alarm if inside target radius and not already triggered
    if (distanceKm <= radiusKm && !isTriggered) {
      await AsyncStorage.setItem(STORAGE_KEYS.IS_ALARM_TRIGGERED, 'true');
      await triggerAlarmNotification(distanceKm);
      await playContinuousAlarm();
    }
  } catch (err) {
    console.error(`[${LOCATION_TASK_NAME}] Error processing location data:`, err);
  }
});
