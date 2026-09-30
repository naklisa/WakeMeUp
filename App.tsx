import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  StatusBar,
  ActivityIndicator,
  FlatList,
  Keyboard,
  Dimensions,
  ScrollView,
  LogBox,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LeafletMapView } from './src/components/LeafletMapView';
import * as Location from 'expo-location';
import * as DocumentPicker from 'expo-document-picker';
import { isRunningInExpoGo } from 'expo';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Abaikan peringatan environment Expo Go untuk background location
LogBox.ignoreLogs(['Background location is limited in Expo Go']);

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
  STORAGE_KEYS_AUDIO,
  DEFAULT_ALARM_URL,
} from './src/services/audioService';
import { calculateHaversineDistanceKm } from './src/utils/haversine';
import { searchPlacesOSM, SearchLocationResult } from './src/services/geocodingService';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Default koordinat (Monas / Pusat Jakarta)
const DEFAULT_COORDS = {
  latitude: -6.1754,
  longitude: 106.8272,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

export default function App() {
  // Status Lokasi & Navigasi
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [targetCoords, setTargetCoords] = useState<{ latitude: number; longitude: number } | null>({
    latitude: -6.1767,
    longitude: 106.8306, // Default Stasiun Gambir
  });
  const [targetName, setTargetName] = useState<string>('Stasiun Gambir Jakarta');
  const [radiusKm, setRadiusKm] = useState<number>(3.0);

  // Status Statistik Realtime (ala Ojol)
  const [currentDistance, setCurrentDistance] = useState<number | null>(null);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState<number>(0);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [isAlarmActive, setIsAlarmActive] = useState<boolean>(false);

  // Status Pencarian
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchLocationResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [showSearchResults, setShowSearchResults] = useState<boolean>(false);

  // Status Custom Audio
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);
  const [customAudioUri, setCustomAudioUri] = useState<string | null>(null);
  const [isTestingAudio, setIsTestingAudio] = useState<boolean>(false);

  // Panel Kontrol Bawah (Expanded / Collapsed)
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundWatchSub = useRef<Location.LocationSubscription | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inExpoGo = isRunningInExpoGo();

  useEffect(() => {
    setupNotificationChannel();
    restoreSavedState();
    fetchCurrentLocationOnce();

    // Polling sinkronisasi status dari background task
    pollIntervalRef.current = setInterval(() => {
      syncBackgroundData();
    }, 2000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (foregroundWatchSub.current) foregroundWatchSub.current.remove();
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  /**
   * Pulihkan pengaturan tersimpan dari AsyncStorage
   */
  const restoreSavedState = async () => {
    try {
      if (!inExpoGo) {
        const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        setIsTracking(isRunning);
      } else {
        const active = await AsyncStorage.getItem(STORAGE_KEYS.TRACKING_ACTIVE);
        setIsTracking(active === 'true');
      }

      const [
        savedLat,
        savedLon,
        savedRad,
        savedName,
        savedAudioUri,
        savedAudioName,
        triggered,
      ] = await AsyncStorage.multiGet([
        STORAGE_KEYS.TARGET_LAT,
        STORAGE_KEYS.TARGET_LON,
        STORAGE_KEYS.TARGET_RADIUS,
        STORAGE_KEYS.TARGET_NAME,
        STORAGE_KEYS_AUDIO.CUSTOM_ALARM_URI,
        STORAGE_KEYS_AUDIO.CUSTOM_ALARM_NAME,
        STORAGE_KEYS.IS_ALARM_TRIGGERED,
      ]);

      if (savedLat[1] && savedLon[1]) {
        setTargetCoords({
          latitude: parseFloat(savedLat[1]),
          longitude: parseFloat(savedLon[1]),
        });
      }
      if (savedRad[1]) setRadiusKm(parseFloat(savedRad[1]));
      if (savedName[1]) setTargetName(savedName[1]);
      if (savedAudioUri[1]) setCustomAudioUri(savedAudioUri[1]);
      if (savedAudioName[1]) setCustomAudioName(savedAudioName[1]);
      if (triggered[1] === 'true') setIsAlarmActive(true);

      const soundPlaying = await isAlarmSoundPlaying();
      if (soundPlaying) setIsAlarmActive(true);
    } catch (e) {
      console.error('Error saat memulihkan state:', e);
    }
  };

  /**
   * Ambil lokasi pengguna saat aplikasi pertama kali dibuka
   */
  const fetchCurrentLocationOnce = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const userLoc = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };

      setUserCoords(userLoc);
    } catch (error) {
      console.warn('Gagal mengambil lokasi awal:', error);
    }
  };

  /**
   * Sinkronisasi data realtime dari background worker
   */
  const syncBackgroundData = async () => {
    try {
      if (!inExpoGo) {
        const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        setIsTracking(isRunning);
      }

      const [
        distanceVal,
        speedVal,
        triggeredVal,
        currentLatVal,
        currentLonVal,
      ] = await AsyncStorage.multiGet([
        STORAGE_KEYS.CURRENT_DISTANCE,
        STORAGE_KEYS.CURRENT_SPEED,
        STORAGE_KEYS.IS_ALARM_TRIGGERED,
        STORAGE_KEYS.CURRENT_LAT,
        STORAGE_KEYS.CURRENT_LON,
      ]);

      if (currentLatVal[1] && currentLonVal[1]) {
        setUserCoords({
          latitude: parseFloat(currentLatVal[1]),
          longitude: parseFloat(currentLonVal[1]),
        });
      }

      if (distanceVal[1]) {
        const d = parseFloat(distanceVal[1]);
        setCurrentDistance(d);
        hitungETA(d, currentSpeedKmh);
      }

      if (speedVal[1]) {
        setCurrentSpeedKmh(parseFloat(speedVal[1]));
      }

      if (triggeredVal[1] === 'true') {
        setIsAlarmActive(true);
      }
    } catch (e) {
      console.error('Error sinkronisasi:', e);
    }
  };

  /**
   * Hitung Estimasi Waktu Tiba (ETA) dinamis
   */
  const hitungETA = (distanceKm: number, speedKmH: number) => {
    if (distanceKm <= 0) {
      setEtaMinutes(0);
      return;
    }

    // Jika kendaraan berhenti/macet (kecepatan < 5 km/jam), gunakan asumsi rata-rata bus kota 30 km/jam
    const effectiveSpeed = speedKmH > 5 ? speedKmH : 30;
    const timeHours = distanceKm / effectiveSpeed;
    const minutes = Math.max(1, Math.round(timeHours * 60));
    setEtaMinutes(minutes);
  };

  /**
   * Pencarian tempat dengan debounce (OpenStreetMap)
   */
  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (text.trim().length < 3) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    setIsSearching(true);
    setShowSearchResults(true);

    searchTimeoutRef.current = setTimeout(async () => {
      const results = await searchPlacesOSM(text);
      setSearchResults(results);
      setIsSearching(false);
    }, 600);
  };

  /**
   * Pilih tempat dari hasil pencarian
   */
  const handleSelectSearchResult = (item: SearchLocationResult) => {
    Keyboard.dismiss();
    setShowSearchResults(false);
    setSearchQuery(item.name);

    Alert.alert(
      'Tandai Lokasi Tujuan 📍',
      `Jadikan "${item.name}" sebagai tujuan perjalanan kamu?`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Ya, Tandai',
          onPress: () => {
            const coords = { latitude: item.latitude, longitude: item.longitude };
            setTargetCoords(coords);
            setTargetName(item.name);

            if (userCoords) {
              const dist = calculateHaversineDistanceKm(
                userCoords.latitude,
                userCoords.longitude,
                coords.latitude,
                coords.longitude
              );
              setCurrentDistance(dist);
              hitungETA(dist, currentSpeedKmh);
            }
          },
        },
      ]
    );
  };

  /**
   * Ketuk langsung di mana saja pada peta
   */
  const handleMapPress = (coords: { latitude: number; longitude: number }) => {
    if (isTracking) return; // Kunci saat tracking berjalan

    const { latitude, longitude } = coords;

    Alert.alert(
      'Tandai Titik Peta 📍',
      'Apakah kamu ingin menjadikan titik ini sebagai lokasi tujuan akhir?',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Ya, Jadikan Tujuan',
          onPress: () => {
            const coords = { latitude, longitude };
            setTargetCoords(coords);
            setTargetName('Titik Terpilih di Peta');

            if (userCoords) {
              const dist = calculateHaversineDistanceKm(
                userCoords.latitude,
                userCoords.longitude,
                latitude,
                longitude
              );
              setCurrentDistance(dist);
              hitungETA(dist, currentSpeedKmh);
            }
          },
        },
      ]
    );
  };

  /**
   * Pilih Musik / Audio Custom dari penyimpanan HP
   */
  const handlePickCustomAudio = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const file = result.assets[0];
        setCustomAudioUri(file.uri);
        setCustomAudioName(file.name);

        await AsyncStorage.multiSet([
          [STORAGE_KEYS_AUDIO.CUSTOM_ALARM_URI, file.uri],
          [STORAGE_KEYS_AUDIO.CUSTOM_ALARM_NAME, file.name],
        ]);

        Alert.alert('Musik Berhasil Dipilih 🎵', `Lagu "${file.name}" akan dijadikan nada alarm.`);
      }
    } catch (error) {
      console.error('Error memilih musik:', error);
      Alert.alert('Gagal Memilih File', 'Tidak dapat membuka pengelola file audio.');
    }
  };

  /**
   * Kembalikan nada alarm ke standar bawaan
   */
  const handleResetDefaultAudio = async () => {
    try {
      await stopContinuousAlarm();
      setIsTestingAudio(false);
      setCustomAudioUri(null);
      setCustomAudioName(null);

      await AsyncStorage.multiRemove([
        STORAGE_KEYS_AUDIO.CUSTOM_ALARM_URI,
        STORAGE_KEYS_AUDIO.CUSTOM_ALARM_NAME,
      ]);

      Alert.alert('Nada Alarm Direset', 'Kembali menggunakan suara alarm sirine standar bawaan.');
    } catch (e) {
      console.error('Error reset audio:', e);
    }
  };

  /**
   * Tes putar audio alarm
   */
  const handleToggleTestAudio = async () => {
    if (isTestingAudio) {
      await stopContinuousAlarm();
      setIsTestingAudio(false);
    } else {
      await playContinuousAlarm(customAudioUri);
      setIsTestingAudio(true);
    }
  };

  /**
   * Verifikasi izin lokasi bertingkat
   */
  const checkPermissions = async (): Promise<boolean> => {
    await requestNotificationPermissionSafely();

    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      Alert.alert(
        'Izin Lokasi Diperlukan',
        'Aplikasi membutuhkan izin akses GPS untuk melacak jarak perjalananmu.'
      );
      return false;
    }

    if (!inExpoGo) {
      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        Alert.alert(
          'Izin Latar Belakang Diperlukan',
          'Agar alarm tetap menyala saat HP terkunci/di saku, pilih "Izinkan sepanjang waktu" (Allow all the time) pada pengaturan aplikasi.'
        );
        return false;
      }
    }

    return true;
  };

  /**
   * Mulai Pelacakan Realtime
   */
  const handleStartTracking = async () => {
    if (!targetCoords) {
      Alert.alert('Tujuan Belum Dipilih', 'Silakan cari tempat atau ketuk peta untuk menentukan tujuan.');
      return;
    }

    const permitted = await checkPermissions();
    if (!permitted) return;

    try {
      // Simpan parameter tujuan ke AsyncStorage
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.TARGET_LAT, targetCoords.latitude.toString()],
        [STORAGE_KEYS.TARGET_LON, targetCoords.longitude.toString()],
        [STORAGE_KEYS.TARGET_RADIUS, radiusKm.toString()],
        [STORAGE_KEYS.TARGET_NAME, targetName],
        [STORAGE_KEYS.IS_ALARM_TRIGGERED, 'false'],
        [STORAGE_KEYS.TRACKING_ACTIVE, 'true'],
      ]);

      // Ambil posisi sekarang dan hitung jarak awal
      const currentPos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });

      const userLoc = {
        latitude: currentPos.coords.latitude,
        longitude: currentPos.coords.longitude,
      };
      setUserCoords(userLoc);

      const initialDist = calculateHaversineDistanceKm(
        userLoc.latitude,
        userLoc.longitude,
        targetCoords.latitude,
        targetCoords.longitude
      );
      setCurrentDistance(initialDist);
      hitungETA(initialDist, (currentPos.coords.speed || 0) * 3.6);

      // Jika dijalankan di Expo Go: gunakan watchPositionAsync untuk live tracking di foreground
      if (inExpoGo) {
        foregroundWatchSub.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 2000,
            distanceInterval: 5,
          },
          async (loc) => {
            const liveLoc = {
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            };
            setUserCoords(liveLoc);

            const speed = loc.coords.speed && loc.coords.speed > 0 ? loc.coords.speed * 3.6 : 0;
            setCurrentSpeedKmh(Math.round(speed));

            const dist = calculateHaversineDistanceKm(
              liveLoc.latitude,
              liveLoc.longitude,
              targetCoords.latitude,
              targetCoords.longitude
            );
            setCurrentDistance(dist);
            hitungETA(dist, speed);

            const triggered = await AsyncStorage.getItem(STORAGE_KEYS.IS_ALARM_TRIGGERED);
            if (dist <= radiusKm && triggered !== 'true') {
              await AsyncStorage.setItem(STORAGE_KEYS.IS_ALARM_TRIGGERED, 'true');
              setIsAlarmActive(true);
              await triggerAlarmNotification(dist);
              await playContinuousAlarm(customAudioUri);
            }
          }
        );
      } else {
        // Pada Standalone APK: Jalankan background location dengan Foreground Service
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 15,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'WakeMeUp Aktif 🚌⏰',
            notificationBody: `Mengawal tidurmu menuju ${targetName} (Radius alarm: ${radiusKm} km).`,
            notificationColor: '#ef4444',
          },
        });
      }

      setIsTracking(true);
      setIsAlarmActive(false);
      Alert.alert(
        'Perjalanan Dimulai! 🚀',
        `WakeMeUp sedang melacak posisimu. Alarm akan berbunyi saat kamu berjarak ≤ ${radiusKm} km dari ${targetName}.`
      );
    } catch (err: any) {
      console.error('Error mulai tracking:', err);
      Alert.alert('Gagal Memulai', err.message || 'Tidak dapat mengaktifkan pelacakan.');
    }
  };

  /**
   * Hentikan Pelacakan & Matikan Alarm
   */
  const handleStopTracking = async () => {
    try {
      if (foregroundWatchSub.current) {
        foregroundWatchSub.current.remove();
        foregroundWatchSub.current = null;
      }

      if (!inExpoGo) {
        const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        if (isRunning) {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        }
      }

      await stopContinuousAlarm();
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.TRACKING_ACTIVE, 'false'],
        [STORAGE_KEYS.IS_ALARM_TRIGGERED, 'false'],
      ]);

      setIsTracking(false);
      setIsAlarmActive(false);
      setIsTestingAudio(false);
    } catch (error) {
      console.error('Error menghentikan tracking:', error);
    }
  };

  /**
   * Pusatkan kamera peta ke lokasi pengguna
   */
  const handleRecenterToUser = () => {
    fetchCurrentLocationOnce();
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* PETA INTERAKTIF OPENSTREETMAP */}
      <LeafletMapView
        userCoords={userCoords}
        targetCoords={targetCoords}
        targetName={targetName}
        radiusKm={radiusKm}
        isTracking={isTracking}
        onMapPress={handleMapPress}
      />

      {/* BANNER ALARM BERBUNYI (Saat Sampai Radius) */}
      {isAlarmActive && (
        <View style={styles.alarmFloatingBanner}>
          <Text style={styles.alarmFloatingTitle}>🚨 WAKE UP! SUDAH SAMPAI! 🚨</Text>
          <Text style={styles.alarmFloatingSub}>
            Kamu sudah berada di dalam radius {radiusKm} km dari {targetName}!
          </Text>
          <TouchableOpacity
            style={styles.alarmFloatingButton}
            onPress={handleStopTracking}
            activeOpacity={0.8}
          >
            <Text style={styles.alarmFloatingButtonText}>MATIKAN ALARM SEKARANG</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* SEARCH BAR MENGAMBANG DI ATAS PETA */}
      {!isTracking && (
        <View style={styles.searchContainer}>
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              placeholder="Cari stasiun, terminal, atau tempat tujuan..."
              placeholderTextColor="#94a3b8"
              value={searchQuery}
              onChangeText={handleSearchChange}
              returnKeyType="search"
            />
            {isSearching && <ActivityIndicator size="small" color="#38bdf8" />}
            {searchQuery.length > 0 && !isSearching && (
              <TouchableOpacity
                onPress={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setShowSearchResults(false);
                }}
              >
                <Text style={styles.clearSearchIcon}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* HASIL PENCARIAN DROPDOWN */}
          {showSearchResults && searchResults.length > 0 && (
            <View style={styles.searchResultsList}>
              <FlatList
                data={searchResults}
                keyExtractor={(item) => item.placeId}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.searchResultItem}
                    onPress={() => handleSelectSearchResult(item)}
                  >
                    <Text style={styles.resultItemName}>📍 {item.name}</Text>
                    <Text style={styles.resultItemDesc} numberOfLines={2}>
                      {item.displayName}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}
        </View>
      )}

      {/* TOMBOL PUSATKAN KE LOKASI SAYA */}
      <TouchableOpacity
        style={styles.recenterButton}
        onPress={handleRecenterToUser}
        activeOpacity={0.8}
      >
        <Text style={styles.recenterIcon}>🎯</Text>
      </TouchableOpacity>

      {/* PANEL DASHBOARD BAWAH (Gaya Ojol / Navigasi) */}
      <View style={styles.bottomCard}>
        {/* Header Dashboard */}
        <View style={styles.dashHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dashDestLabel}>TUJUAN PERJALANAN</Text>
            <Text style={styles.dashDestName} numberOfLines={1}>
              {targetName || 'Belum memilih tujuan'}
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              isTracking ? styles.statusBadgeActive : styles.statusBadgeIdle,
            ]}
          >
            <Text style={styles.statusBadgeText}>
              {isTracking ? 'MELACAK' : 'STANDBY'}
            </Text>
          </View>
        </View>

        {/* METRIK REAL-TIME SAAT TRACKING AKTIF (Jarak, Kecepatan, ETA) */}
        {isTracking ? (
          <View style={styles.metricsContainer}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>SISA JARAK</Text>
              <Text style={styles.metricValue}>
                {currentDistance !== null ? `${currentDistance.toFixed(1)} km` : '--'}
              </Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>KECEPATAN</Text>
              <Text style={styles.metricValue}>
                {currentSpeedKmh > 2 ? `${currentSpeedKmh} km/j` : 'Berhenti'}
              </Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>ESTIMASI TIBA</Text>
              <Text style={styles.metricValueHighlight}>
                {etaMinutes !== null ? `~${etaMinutes} mnt` : '--'}
              </Text>
            </View>
          </View>
        ) : (
          /* OPSI PENGATURAN SEBELUM MULAI (Radius & Musik Alarm) */
          <View style={styles.setupContainer}>
            {/* Pemilihan Radius Bangun */}
            <View style={styles.radiusRow}>
              <Text style={styles.setupLabel}>Radius Bangun:</Text>
              <View style={styles.radiusButtonGroup}>
                {[1, 2, 3, 5].map((km) => (
                  <TouchableOpacity
                    key={km}
                    style={[
                      styles.radiusPill,
                      radiusKm === km && styles.radiusPillActive,
                    ]}
                    onPress={() => setRadiusKm(km)}
                  >
                    <Text
                      style={[
                        styles.radiusPillText,
                        radiusKm === km && styles.radiusPillTextActive,
                      ]}
                    >
                      {km} km
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Pemilihan Musik Custom */}
            <View style={styles.audioRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupLabel}>Nada Alarm:</Text>
                <Text style={styles.audioNameText} numberOfLines={1}>
                  🎵 {customAudioName || 'Sirine Digital (Standar)'}
                </Text>
              </View>

              <View style={styles.audioButtons}>
                <TouchableOpacity
                  style={styles.audioActionBtn}
                  onPress={handlePickCustomAudio}
                >
                  <Text style={styles.audioActionBtnText}>Pilih Lagu</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.audioActionBtn, isTestingAudio && styles.audioTestActive]}
                  onPress={handleToggleTestAudio}
                >
                  <Text style={styles.audioActionBtnText}>
                    {isTestingAudio ? 'Stop' : 'Tes'}
                  </Text>
                </TouchableOpacity>

                {customAudioUri && (
                  <TouchableOpacity
                    style={styles.audioResetBtn}
                    onPress={handleResetDefaultAudio}
                  >
                    <Text style={styles.audioResetBtnText}>Reset</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        )}

        {/* TOMBOL AKSI UTAMA (Mulai / Hentikan Perjalanan) */}
        <View style={styles.mainActionRow}>
          {!isTracking ? (
            <TouchableOpacity
              style={styles.startTripButton}
              onPress={handleStartTracking}
              activeOpacity={0.8}
            >
              <Text style={styles.startTripButtonText}>
                🚀 MULAI PERJALANAN (WAKE ME UP)
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.stopTripButton}
              onPress={handleStopTracking}
              activeOpacity={0.8}
            >
              <Text style={styles.stopTripButtonText}>
                🛑 HENTIKAN PERJALANAN
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  map: {
    ...StyleSheet.absoluteFill,
  },
  /* Floating Search Bar */
  searchContainer: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    zIndex: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  searchIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 14,
    paddingVertical: 2,
  },
  clearSearchIcon: {
    color: '#94a3b8',
    fontSize: 16,
    paddingHorizontal: 6,
  },
  searchResultsList: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    marginTop: 6,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
  },
  searchResultItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  resultItemName: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  resultItemDesc: {
    color: '#94a3b8',
    fontSize: 12,
  },
  /* Recenter Button */
  recenterButton: {
    position: 'absolute',
    bottom: 250,
    right: 16,
    backgroundColor: '#1e293b',
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    elevation: 6,
  },
  recenterIcon: {
    fontSize: 22,
  },
  /* Floating Alarm Ringing Banner */
  alarmFloatingBanner: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    backgroundColor: '#dc2626',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    zIndex: 99,
    elevation: 12,
    shadowColor: '#dc2626',
    shadowOpacity: 0.8,
    shadowRadius: 12,
  },
  alarmFloatingTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 4,
  },
  alarmFloatingSub: {
    color: '#fee2e2',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  alarmFloatingButton: {
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
  },
  alarmFloatingButtonText: {
    color: '#dc2626',
    fontSize: 15,
    fontWeight: '900',
  },
  /* Bottom Dashboard Panel */
  bottomCard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
  },
  dashHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  dashDestLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  dashDestName: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusBadgeActive: {
    backgroundColor: '#16a34a',
  },
  statusBadgeIdle: {
    backgroundColor: '#475569',
  },
  statusBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  /* Real-time Tracking Metrics (Ojol style) */
  metricsContainer: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
    marginBottom: 16,
    justifyContent: 'space-around',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  metricBox: {
    alignItems: 'center',
    flex: 1,
  },
  metricLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metricValue: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '900',
  },
  metricValueHighlight: {
    color: '#38bdf8',
    fontSize: 18,
    fontWeight: '900',
  },
  metricDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#334155',
  },
  /* Setup Options Before Starting */
  setupContainer: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
    gap: 12,
  },
  setupLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  radiusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  radiusButtonGroup: {
    flexDirection: 'row',
    gap: 6,
  },
  radiusPill: {
    backgroundColor: '#0f172a',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  radiusPillActive: {
    backgroundColor: '#38bdf8',
    borderColor: '#38bdf8',
  },
  radiusPillText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  radiusPillTextActive: {
    color: '#0f172a',
    fontWeight: '800',
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  audioNameText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 180,
  },
  audioButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  audioActionBtn: {
    backgroundColor: '#334155',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  audioTestActive: {
    backgroundColor: '#ef4444',
  },
  audioActionBtnText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
  },
  audioResetBtn: {
    backgroundColor: '#475569',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  audioResetBtnText: {
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: '700',
  },
  /* Main Action Buttons */
  mainActionRow: {
    width: '100%',
  },
  startTripButton: {
    backgroundColor: '#16a34a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#16a34a',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  startTripButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  stopTripButton: {
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#dc2626',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  stopTripButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
});
