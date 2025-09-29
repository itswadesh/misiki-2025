# Misiki

## Developing
Copy .env.example -> .env

```bash
bun install
bun run db:migrate
bun run dev
```

## Building for Production

### Web Build
```bash
bun run build
```

### Mobile Build (Android)

#### Prerequisites
- Node.js and bun
- **Java 11 or higher** (required for Android builds)
  - Check version: `java -version`
  - If you see "Unsupported major.minor version 50.0", you need to update Java
  - **Installation steps:**
    1. Download Java 11+ from: https://adoptium.net/temurin/releases/
    2. Install the JDK
    3. Set JAVA_HOME environment variable to the Java installation directory
    4. Add `%JAVA_HOME%\bin` (Windows) or `$JAVA_HOME/bin` (Linux/Mac) to your PATH
    5. Restart your terminal/command prompt
    6. Verify: `java -version` should show version 11 or higher
- Android Studio (for Android SDK) - optional, but recommended for Android development

#### Setup
1. Install Capacitor dependencies:
```bash
bun install @capacitor/core @capacitor/cli @capacitor/android
```

2. Build the web app:
```bash
bun run build
```

3. Sync web assets to Android:
```bash
bunx cap sync android
```

#### Building APK/AAB

1. **Debug APK** (for testing):
```bash
cd android
./gradlew assembleDebug  # Linux/Mac
gradlew.bat assembleDebug  # Windows
```
The APK will be at: `android/app/build/outputs/apk/debug/app-debug.apk`

2. **Release APK** (for Play Store - legacy):
```bash
cd android
./gradlew assembleRelease  # Linux/Mac
gradlew.bat assembleRelease  # Windows
```
The APK will be at: `android/app/build/outputs/apk/release/app-release-unsigned.apk`

3. **Android App Bundle (AAB)** (recommended for Play Store):
```bash
cd android
./gradlew bundleRelease  # Linux/Mac
gradlew.bat bundleRelease  # Windows
```
The AAB will be at: `android/app/build/outputs/bundle/release/app-release.aab`

#### Signing the Release APK/AAB

1. Create a keystore (if you don't have one):
```bash
keytool -genkey -v -keystore my-release-key.keystore -alias alias_name -keyalg RSA -keysize 2048 -validity 10000
```

2. **For APK signing:**
```bash
jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 -keystore my-release-key.keystore android/app/build/outputs/apk/release/app-release-unsigned.apk alias_name
zipalign -v 4 android/app/build/outputs/apk/release/app-release-unsigned.apk android/app/build/outputs/apk/release/app-release.apk
```

3. **AAB files are automatically signed** during the bundleRelease build process. No additional signing steps needed.

## Publishing to Google Play Store

1. Create a Google Play Console account at https://play.google.com/console/
2. Create a new app in the console
3. **Upload your build:**
   - **For AAB (recommended)**: Upload `app-release.aab` from the bundle release
   - **For APK (legacy)**: Upload the signed `app-release.apk`
4. Fill in store listing details (title, description, screenshots, etc.)
5. Set pricing and distribution
6. Publish the app

**Note**: Google Play Store now requires AAB format for new apps. APKs are still accepted for updates to existing apps.

### Troubleshooting

#### Java Version Error
If you encounter: `Unsupported major.minor version 50.0`
- This means you're using Java 6 or older
- You need Java 11 or higher for Android development
- Follow the installation steps above
- After installing, run: `java -version` to confirm
- Restart your terminal/command prompt after setting environment variables

#### Common Issues
- **Gradle build fails**: Ensure Java 11+ is properly installed and JAVA_HOME is set
- **Capacitor sync fails**: Make sure the `build/` directory exists and contains `index.html`
- **APK signing fails**: Ensure your keystore file exists and password is correct

### Notes
- The mobile code is kept separately in the `android/` folder
- Web assets are built to `build/` directory
- Make sure to update version codes in `android/app/build.gradle` for new releases
