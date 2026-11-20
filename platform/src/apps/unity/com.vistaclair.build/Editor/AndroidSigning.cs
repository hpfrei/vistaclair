// Shipped by the vistaclair unity platform extra (/opt/vistaclair-unity/packages/
// com.vistaclair.build); an app references it from Packages/manifest.json as
// "com.vistaclair.build": "file:/opt/vistaclair-unity/packages/com.vistaclair.build".
//
// Every Android build is signed from the environment, never from key material
// in the project:
//   UNITY_ANDROID_KEYSTORE_PATH        the keystore file (the app writes it from its secrets)
//   UNITY_ANDROID_KEYSTORE_PASS        its store password
//   UNITY_ANDROID_KEYSTORE_ALIAS       the key alias
//   UNITY_ANDROID_KEYSTORE_ALIAS_PASS  the key password (default: the store password)
// Without UNITY_ANDROID_KEYSTORE_PATH the extra's shared debug keystore
// (<root>/keystores/debug.keystore, android / androiddebugkey / android) signs.
// The project's own keystore settings are put back after the build (Unity never
// serializes the passwords; a failed build can leave the keystore path behind).
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Vistaclair.Build
{
    public class AndroidSigning : IPreprocessBuildWithReport, IPostprocessBuildWithReport
    {
        public const string DefaultRoot = "/opt/vistaclair-unity";
        public int callbackOrder => -1000;

        static bool s_Saved;
        static bool s_Custom;
        static string s_Keystore, s_Alias;

        static string Env(string name)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }

        // <root>/keystores/debug.keystore, the root taken from VC_UNITY_ROOT (bin/unity
        // exports it) or this package's own location (<root>/packages/com.vistaclair.build).
        public static string DebugKeystore()
        {
            var root = Env("VC_UNITY_ROOT");
            if (root == null)
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(AndroidSigning).Assembly);
                root = info != null ? Path.GetFullPath(Path.Combine(info.resolvedPath, "..", "..")) : DefaultRoot;
            }
            return Path.Combine(root, "keystores", "debug.keystore");
        }

        public void OnPreprocessBuild(BuildReport report)
        {
            if (report.summary.platform != BuildTarget.Android) return;
            s_Custom = PlayerSettings.Android.useCustomKeystore;
            s_Keystore = PlayerSettings.Android.keystoreName;
            s_Alias = PlayerSettings.Android.keyaliasName;
            s_Saved = true;

            var path = Env("UNITY_ANDROID_KEYSTORE_PATH");
            if (path != null)
            {
                var pass = Env("UNITY_ANDROID_KEYSTORE_PASS");
                var alias = Env("UNITY_ANDROID_KEYSTORE_ALIAS");
                var aliasPass = Env("UNITY_ANDROID_KEYSTORE_ALIAS_PASS") ?? pass;
                if (!File.Exists(path))
                    throw new BuildFailedException("UNITY_ANDROID_KEYSTORE_PATH: no keystore at " + path);
                if (pass == null || alias == null)
                    throw new BuildFailedException("UNITY_ANDROID_KEYSTORE_PATH is set: UNITY_ANDROID_KEYSTORE_PASS and UNITY_ANDROID_KEYSTORE_ALIAS are required too");
                Apply(Path.GetFullPath(path), pass, alias, aliasPass);
                Debug.Log("[vistaclair.build] Android signing: release keystore " + path + " (alias " + alias + ")");
                return;
            }
            var debug = DebugKeystore();
            if (!File.Exists(debug))
                throw new BuildFailedException("no UNITY_ANDROID_KEYSTORE_PATH and no shared debug keystore at " + debug + " — install the unity extra under Apps → Setup → Extras");
            Apply(debug, "android", "androiddebugkey", "android");
            Debug.Log("[vistaclair.build] Android signing: the shared debug keystore " + debug);
        }

        static void Apply(string keystore, string pass, string alias, string aliasPass)
        {
            PlayerSettings.Android.useCustomKeystore = true;
            PlayerSettings.Android.keystoreName = keystore;
            PlayerSettings.Android.keystorePass = pass;
            PlayerSettings.Android.keyaliasName = alias;
            PlayerSettings.Android.keyaliasPass = aliasPass;
        }

        public void OnPostprocessBuild(BuildReport report)
        {
            if (report.summary.platform != BuildTarget.Android || !s_Saved) return;
            PlayerSettings.Android.keystorePass = "";
            PlayerSettings.Android.keyaliasPass = "";
            PlayerSettings.Android.useCustomKeystore = s_Custom;
            PlayerSettings.Android.keystoreName = s_Keystore;
            PlayerSettings.Android.keyaliasName = s_Alias;
            s_Saved = false;
        }
    }
}
