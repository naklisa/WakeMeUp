import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  SafeAreaView,
  ScrollView,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { isRunningInExpoGo } from 'expo';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LOCATION_TASK_NAME,
  STORAGE_KEYS,
} from './src/services/locationTask';
import {
  setupNotificationChannel,
  requestNotificationPermissionSafely,
  triggerAlarmNotification,
} from './src/services/notificationService';
import {
  playContinuousAlarm,
  stopContinuousAlarm,
  isAlarmSoundPlaying,
} from './src/services/audioService';
import { calculateHaversineDistanceKm } from './src/utils/haversine';

export default function App() {
  // Target destination state (Defaults to Stasiun Gambir Jakarta as practical sample)
  const [targetLat, setTargetLat] = useState<string>('-6.1767');
  const [targetLon, setTargetLon] = useState<string>('106.8306');
  const [radiusKm, setRadiusKm] = useState<string>('3.0');

  // Tracking & Location states
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [currentDistance, setCurrentDistance] = useState<string | null>(null);
  const [currentCoords, setCurrentCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [isAlarmActive, setIsAlarmActive] = useState<boolean>(false);
  const [loadingCurrentLocation, setLoadingCurrentLocation] = useState<boolean>(false);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundWatchSub = useRef<Location.LocationSubscription | null>(null);

  const inExpoGo = isRunningInExpoGo();

  useEffect(() => {
    // 1. Initialize notification channel for Android (if not Expo Go)
    setupNotificationChannel();

    // 2. Restore saved destination & tracking status
    syncInitialState();

    // 3. Periodic polling to keep UI updated with background changes
    pollIntervalRef.current = setInterval(() => {
      refreshLiveStatus();
    }, 2500);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (foregroundWatchSub.current) {
        foregroundWatchSub.current.remove();
      }
    };
  }, []);

  /**
   * Restores persistent state upon opening the app
   */
  const syncInitialState = async () => {
    try {
      const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      setIsTracking(isRunning);

      const [savedLat, savedLon, savedRadius, triggered, distance] =
        await AsyncStorage.multiGet([
          STORAGE_KEYS.TARGET_LAT,
          STORAGE_KEYS.TARGET_LON,
          STORAGE_KEYS.TARGET_RADIUS,
          STORAGE_KEYS.IS_ALARM_TRIGGERED,
          STORAGE_KEYS.CURRENT_DISTANCE,
        ]);

      if (savedLat[1]) setTargetLat(savedLat[1]);
      if (savedLon[1]) setTargetLon(savedLon[1]);
      if (savedRadius[1]) setRadiusKm(savedRadius[1]);
      if (triggered[1] === 'true') setIsAlarmActive(true);
      if (distance[1]) setCurrentDistance(distance[1]);

      const soundPlaying = await isAlarmSoundPlaying();
      if (soundPlaying) setIsAlarmActive(true);
    } catch (e) {
      console.error('Error synchronizing initial state:', e);
    }
  };

  /**
   * Refreshes distance and alarm status from AsyncStorage and live location
   */
  const refreshLiveStatus = async () => {
    try {
      const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (!inExpoGo) {
        setIsTracking(isRunning);
      }

      const [distance, triggered, currentLat, currentLon] =
        await AsyncStorage.multiGet([
          STORAGE_KEYS.CURRENT_DISTANCE,
          STORAGE_KEYS.IS_ALARM_TRIGGERED,
          STORAGE_KEYS.CURRENT_LAT,
          STORAGE_KEYS.CURRENT_LON,
        ]);

      if (distance[1]) setCurrentDistance(distance[1]);
      if (triggered[1] === 'true') setIsAlarmActive(true);

      if (currentLat[1] && currentLon[1]) {
        setCurrentCoords({
          lat: parseFloat(currentLat[1]),
          lon: parseFloat(currentLon[1]),
        });
      }
    } catch (e) {
      console.error('Error refreshing live status:', e);
    }
  };

  /**
   * Graceful permissions request:
   * Notifications -> Foreground Location -> Background Location
   */
  const verifyAndRequestPermissions = async (): Promise<boolean> => {
    // 1. Notification permissions (safely handles Expo Go)
    await requestNotificationPermissionSafely();

    // 2. Foreground Location
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      Alert.alert(
        'Foreground Location Required',
        'We need access to your device location to measure your journey distance.'
      );
      return false;
    }

    // 3. Background Location (Android requires foreground to be approved first)
    if (!inExpoGo) {
      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        Alert.alert(
          'Background Location Required',
          'To track your location and wake you up while your screen is off, please select "Allow all the time" in your device location settings.'
        );
        return false;
      }
    }

    return true;
  };

  /**
   * Fills the inputs with user's current GPS location
   */
  const handleUseCurrentLocation = async () => {
    setLoadingCurrentLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required.');
        setLoadingCurrentLocation(false);
        return;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      setTargetLat(location.coords.latitude.toFixed(6));
      setTargetLon(location.coords.longitude.toFixed(6));
      setCurrentCoords({
        lat: location.coords.latitude,
        lon: location.coords.longitude,
      });
      Alert.alert('Location Acquired', 'Target coordinates updated to your current location.');
    } catch (error) {
      Alert.alert('Error', 'Could not get current location.');
    } finally {
      setLoadingCurrentLocation(false);
    }
  };

  /**
   * Starts tracking (Background for APK / Foreground watcher fallback for Expo Go)
   */
  const handleStartTracking = async () => {
    const lat = parseFloat(targetLat);
    const lon = parseFloat(targetLon);
    const rad = parseFloat(radiusKm);

    if (isNaN(lat) || isNaN(lon) || isNaN(rad) || rad <= 0) {
      Alert.alert('Invalid Parameters', 'Please enter valid numbers for latitude, longitude, and radius.');
      return;
    }

    const permitted = await verifyAndRequestPermissions();
    if (!permitted) return;

    try {
      // Save targets into AsyncStorage for background worker
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.TARGET_LAT, lat.toString()],
        [STORAGE_KEYS.TARGET_LON, lon.toString()],
        [STORAGE_KEYS.TARGET_RADIUS, rad.toString()],
        [STORAGE_KEYS.IS_ALARM_TRIGGERED, 'false'],
        [STORAGE_KEYS.TRACKING_ACTIVE, 'true'],
      ]);

      // Calculate initial distance
      try {
        const currentPos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const dist = calculateHaversineDistanceKm(
          currentPos.coords.latitude,
          currentPos.coords.longitude,
          lat,
          lon
        );
        setCurrentDistance(dist.toFixed(2));
        setCurrentCoords({
          lat: currentPos.coords.latitude,
          lon: currentPos.coords.longitude,
        });

        // Trigger alarm immediately if already in radius
        if (dist <= rad) {
          setIsAlarmActive(true);
          await AsyncStorage.setItem(STORAGE_KEYS.IS_ALARM_TRIGGERED, 'true');
          await triggerAlarmNotification(dist);
          await playContinuousAlarm();
        }
      } catch {
        // non-blocking
      }

      if (inExpoGo) {
        // Expo Go fallback: Use watchPositionAsync in foreground for testing
        foregroundWatchSub.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 3000,
            distanceInterval: 10,
          },
          async (loc) => {
            const dist = calculateHaversineDistanceKm(
              loc.coords.latitude,
              loc.coords.longitude,
              lat,
              lon
            );
            setCurrentDistance(dist.toFixed(2));
            setCurrentCoords({
              lat: loc.coords.latitude,
              lon: loc.coords.longitude,
            });

            const triggered = await AsyncStorage.getItem(STORAGE_KEYS.IS_ALARM_TRIGGERED);
            if (dist <= rad && triggered !== 'true') {
              await AsyncStorage.setItem(STORAGE_KEYS.IS_ALARM_TRIGGERED, 'true');
              setIsAlarmActive(true);
              await triggerAlarmNotification(dist);
              await playContinuousAlarm();
            }
          }
        );

        setIsTracking(true);
        setIsAlarmActive(false);
        Alert.alert(
          'Tracking Started (Expo Go)',
          'Tracking is active! Note: Expo Go only tracks while app is open. For background tracking while locked, build the APK with EAS.'
        );
      } else {
        // Standalone APK Build: Full Background Location with Foreground Service
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.High,
          timeInterval: 10000,
          distanceInterval: 25,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'WakeMeUp Active 🚌⏰',
            notificationBody: `Tracking destination (${rad} km alert radius). Rest easy!`,
            notificationColor: '#ef4444',
          },
        });

        setIsTracking(true);
        setIsAlarmActive(false);
        Alert.alert(
          'Tracking Active',
          'WakeMeUp is now tracking your location in the background. You can safely lock your screen or sleep!'
        );
      }
    } catch (err: any) {
      console.error('Error starting location tracking:', err);
      Alert.alert('Failed to Start', err.message || 'Could not start tracking service.');
    }
  };

  /**
   * Stops tracking and deactivates any active alarm
   */
  const handleStopTracking = async () => {
    try {
      if (foregroundWatchSub.current) {
        foregroundWatchSub.current.remove();
        foregroundWatchSub.current = null;
      }

      const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (isRunning) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }

      await stopContinuousAlarm();
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.TRACKING_ACTIVE, 'false'],
        [STORAGE_KEYS.IS_ALARM_TRIGGERED, 'false'],
      ]);

      setIsTracking(false);
      setIsAlarmActive(false);
    } catch (error) {
      console.error('Error stopping tracking:', error);
    }
  };

  /**
   * Test audio feature
   */
  const handleTestAlarmAudio = async () => {
    if (isAlarmActive) {
      await stopContinuousAlarm();
      setIsAlarmActive(false);
    } else {
      await playContinuousAlarm();
      setIsAlarmActive(true);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerEmoji}>🚌 ⏰ 📍</Text>
          <Text style={styles.title}>WakeMeUp</Text>
          <Text style={styles.subtitle}>
            Sleep safely while commuting. An alarm will ring before you reach your destination.
          </Text>
          {inExpoGo && (
            <View style={styles.expoGoPill}>
              <Text style={styles.expoGoPillText}>Expo Go Preview Mode</Text>
            </View>
          )}
        </View>

        {/* Alarm Banner Alert when triggered */}
        {isAlarmActive && (
          <View style={styles.alarmBanner}>
            <Text style={styles.alarmTitle}>🚨 WAKE UP! DESTINATION REACHED 🚨</Text>
            <Text style={styles.alarmSubtext}>
              Continuous alarm sound is currently playing.
            </Text>
            <TouchableOpacity
              style={styles.dismissButton}
              onPress={handleStopTracking}
              activeOpacity={0.8}
            >
              <Text style={styles.dismissButtonText}>DISMISS & STOP ALARM</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Live Status Card */}
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Tracking Status:</Text>
            <View
              style={[
                styles.badge,
                isTracking ? styles.badgeActive : styles.badgeInactive,
              ]}
            >
              <Text style={styles.badgeText}>
                {isTracking ? (inExpoGo ? 'ACTIVE (EXPO GO)' : 'ACTIVE (BACKGROUND)') : 'IDLE'}
              </Text>
            </View>
          </View>

          {currentDistance !== null && (
            <View style={styles.distanceBlock}>
              <Text style={styles.distanceLabel}>Distance to Destination</Text>
              <Text style={styles.distanceValue}>{currentDistance} km</Text>
              <Text style={styles.radiusHint}>
                (Alarm triggers at ≤ {radiusKm || '0'} km)
              </Text>
            </View>
          )}

          {currentCoords && (
            <Text style={styles.coordsText}>
              Last Known GPS: {currentCoords.lat.toFixed(4)}, {currentCoords.lon.toFixed(4)}
            </Text>
          )}
        </View>

        {/* Inputs Form Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Destination Coordinates</Text>

          <Text style={styles.inputLabel}>Target Latitude</Text>
          <TextInput
            style={styles.input}
            value={targetLat}
            onChangeText={setTargetLat}
            placeholder="-6.1754"
            placeholderTextColor="#64748b"
            keyboardType="numeric"
            editable={!isTracking}
          />

          <Text style={styles.inputLabel}>Target Longitude</Text>
          <TextInput
            style={styles.input}
            value={targetLon}
            onChangeText={setTargetLon}
            placeholder="106.8272"
            placeholderTextColor="#64748b"
            keyboardType="numeric"
            editable={!isTracking}
          />

          <Text style={styles.inputLabel}>Wake-Up Radius (Kilometers)</Text>
          <TextInput
            style={styles.input}
            value={radiusKm}
            onChangeText={setRadiusKm}
            placeholder="3.0"
            placeholderTextColor="#64748b"
            keyboardType="numeric"
            editable={!isTracking}
          />

          {!isTracking && (
            <TouchableOpacity
              style={styles.currentLocButton}
              onPress={handleUseCurrentLocation}
              disabled={loadingCurrentLocation}
              activeOpacity={0.7}
            >
              {loadingCurrentLocation ? (
                <ActivityIndicator color="#38bdf8" />
              ) : (
                <Text style={styles.currentLocButtonText}>
                  📍 Set Target To My Current Location
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Action Buttons */}
        <View style={styles.actions}>
          {!isTracking ? (
            <TouchableOpacity
              style={styles.startButton}
              onPress={handleStartTracking}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonText}>START TRACKING</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.stopButton}
              onPress={handleStopTracking}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonText}>STOP TRACKING</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.testButton}
            onPress={handleTestAlarmAudio}
            activeOpacity={0.7}
          >
            <Text style={styles.testButtonText}>
              {isAlarmActive ? '🔇 Silence Audio Test' : '🔊 Test Alarm Sound'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  headerEmoji: {
    fontSize: 40,
    marginBottom: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 20,
    paddingHorizontal: 12,
  },
  expoGoPill: {
    backgroundColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    marginTop: 8,
  },
  expoGoPillText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '600',
  },
  alarmBanner: {
    backgroundColor: '#dc2626',
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
    marginBottom: 18,
    shadowColor: '#dc2626',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  alarmTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 4,
  },
  alarmSubtext: {
    color: '#fee2e2',
    fontSize: 13,
    marginBottom: 14,
  },
  dismissButton: {
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  dismissButtonText: {
    color: '#dc2626',
    fontSize: 15,
    fontWeight: '800',
  },
  statusCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusLabel: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  badgeActive: {
    backgroundColor: '#16a34a',
  },
  badgeInactive: {
    backgroundColor: '#475569',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  distanceBlock: {
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  distanceLabel: {
    color: '#94a3b8',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  distanceValue: {
    color: '#38bdf8',
    fontSize: 36,
    fontWeight: '900',
    marginVertical: 4,
  },
  radiusHint: {
    color: '#64748b',
    fontSize: 12,
  },
  coordsText: {
    color: '#64748b',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 14,
  },
  inputLabel: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 14,
  },
  currentLocButton: {
    marginTop: 4,
    paddingVertical: 10,
    alignItems: 'center',
  },
  currentLocButtonText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '600',
  },
  actions: {
    gap: 12,
  },
  startButton: {
    backgroundColor: '#16a34a',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#16a34a',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  stopButton: {
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  testButton: {
    backgroundColor: '#334155',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  testButtonText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '600',
  },
});
