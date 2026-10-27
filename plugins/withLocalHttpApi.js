const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withLocalHttpApi(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application entry is missing from the manifest');

    if (process.env.EXPO_PUBLIC_API_URL?.startsWith('http://')) {
      application.$['android:usesCleartextTraffic'] = 'true';
    } else {
      delete application.$['android:usesCleartextTraffic'];
    }

    return modConfig;
  });
};