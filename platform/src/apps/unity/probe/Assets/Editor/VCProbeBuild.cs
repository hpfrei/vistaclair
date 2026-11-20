// The unity extra's install-time probe (src/apps/unity/probe.sh runs it):
//   bin/unity -batchmode -nographics -quit -projectPath <copy> -buildTarget Android -executeMethod VCProbeBuild.Build
// Configures a hello-world Quest app by code — URP, XR Plug-in Management + OpenXR
// with the Meta Quest feature, multiview, Vulkan, IL2CPP ARM64, a scene that
// P/Invokes the Rust cdylib — and builds $VC_PROBE_APK. Its verdicts are `PROBE`
// lines appended to $VC_PROBE_OUT; exit 1 on any failure.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEditor.XR.OpenXR;
using UnityEditor.XR.OpenXR.Features;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features;
using UnityEngine.XR.OpenXR.Features.Interactions;
using UnityEngine.XR.OpenXR.Features.MetaQuestSupport;

public static class VCProbeBuild
{
    const string kPackage = "com.vistaclair.unityprobe";
    const string kScenePath = "Assets/Scenes/Probe.unity";
    const string kOpenXRLoader = "UnityEngine.XR.OpenXR.OpenXRLoader";
    static readonly BuildTargetGroup kGroup = BuildTargetGroup.Android;

    static void Log(string msg) => Debug.Log("[VCProbe] " + msg);

    static void Probe(string check, bool ok, string detail = "")
    {
        var line = "PROBE " + check + " " + (ok ? "ok" : "FAIL") + (string.IsNullOrEmpty(detail) ? "" : " " + detail.Replace('\n', ' '));
        Log(line);
        var outFile = Environment.GetEnvironmentVariable("VC_PROBE_OUT");
        if (!string.IsNullOrEmpty(outFile)) File.AppendAllText(outFile, line + "\n");
    }

    // The first run: Android as the active target and Active Input Handling = Input
    // System (what OpenXR's controller profiles use; no public API). Both only take
    // effect in the NEXT editor run — set in the build run itself, the editor keeps
    // the old input defines while the player compiles with the new ones, and the
    // build fails on fields serialized differently in each.
    public static void Prepare()
    {
        try
        {
            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android
                && !EditorUserBuildSettings.SwitchActiveBuildTarget(kGroup, BuildTarget.Android))
                throw new Exception("SwitchActiveBuildTarget(Android) failed (Android Build Support missing?)");
            var so = ProjectSettingsObject();
            var aih = so.FindProperty("activeInputHandler");
            if (aih == null) throw new Exception("activeInputHandler not found in ProjectSettings");
            if (aih.intValue != 1) { aih.intValue = 1; so.ApplyModifiedPropertiesWithoutUndo(); }
            AssetDatabase.SaveAssets();
            Log("prepared: target Android, activeInputHandler 1");
            EditorApplication.Exit(0);
        }
        catch (Exception e)
        {
            Debug.LogError("[VCProbe] prepare FAILED: " + e);
            EditorApplication.Exit(1);
        }
    }

    static SerializedObject ProjectSettingsObject()
    {
        var ps = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset").FirstOrDefault();
        if (ps == null) throw new Exception("cannot load ProjectSettings.asset");
        return new SerializedObject(ps);
    }

    public static void Build()
    {
        try
        {
            Log("start, Unity " + Application.unityVersion);
            Probe("project", true, Application.unityVersion);
            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android
                && !EditorUserBuildSettings.SwitchActiveBuildTarget(kGroup, BuildTarget.Android))
                throw new Exception("SwitchActiveBuildTarget(Android) failed (Android Build Support missing?)");

            UseEmbeddedAndroidTools();
            ConfigurePlayer();
            ConfigureUrp();
            ConfigureXrManagement();
            ConfigureOpenXr();
            bool rust = ConfigureRustPlugins();
            CreateScene();
            AssetDatabase.SaveAssets();
            if (rust) CallRustFromEditor();

            var apk = Environment.GetEnvironmentVariable("VC_PROBE_APK");
            if (string.IsNullOrEmpty(apk)) apk = Path.Combine(Directory.GetCurrentDirectory(), "out", "probe.apk");
            Directory.CreateDirectory(Path.GetDirectoryName(apk));
            var options = new BuildPlayerOptions
            {
                scenes = new[] { kScenePath },
                locationPathName = apk,
                target = BuildTarget.Android,
                targetGroup = kGroup,
                options = BuildOptions.None,
            };
            Log("BuildPlayer -> " + apk);
            BuildReport report = BuildPipeline.BuildPlayer(options);
            var s = report.summary;
            Log($"result={s.result} errors={s.totalErrors} warnings={s.totalWarnings} time={s.totalTime}");
            if (s.result != BuildResult.Succeeded)
            {
                foreach (var step in report.steps)
                foreach (var m in step.messages)
                    if (m.type == LogType.Error || m.type == LogType.Exception)
                        Log("build error [" + step.name + "]: " + m.content);
                Probe("build", false, s.result + " errors=" + s.totalErrors);
                EditorApplication.Exit(1);
                return;
            }
            Probe("build", true, ((int)s.totalTime.TotalSeconds) + "s");
            EditorApplication.Exit(0);
        }
        catch (Exception e)
        {
            Debug.LogError("[VCProbe] FAILED: " + e);
            Probe("build", false, e.GetType().Name + ": " + e.Message);
            EditorApplication.Exit(1);
        }
    }

    // The editor's own AndroidPlayer/{SDK,NDK,OpenJDK} (what the extra installs).
    static void UseEmbeddedAndroidTools()
    {
        EditorPrefs.SetBool("SdkUseEmbedded", true);
        EditorPrefs.SetBool("NdkUseEmbedded", true);
        EditorPrefs.SetBool("JdkUseEmbedded", true);
        var android = Path.Combine(EditorApplication.applicationContentsPath, "PlaybackEngines/AndroidPlayer");
        foreach (var d in new[] { "SDK", "NDK", "OpenJDK" })
            if (!Directory.Exists(Path.Combine(android, d))) throw new Exception("missing " + Path.Combine(android, d));
        Log("android tools: " + android + "/{SDK,NDK,OpenJDK}");
    }

    static void ConfigurePlayer()
    {
        var nbt = NamedBuildTarget.Android;
        PlayerSettings.companyName = "vistaclair";
        PlayerSettings.productName = "Unity Probe";
        PlayerSettings.SetApplicationIdentifier(nbt, kPackage);
        PlayerSettings.SetScriptingBackend(nbt, ScriptingImplementation.IL2CPP);
        PlayerSettings.SetIl2CppCompilerConfiguration(nbt, Il2CppCompilerConfiguration.Release);
        var jobs = Environment.GetEnvironmentVariable("IL2CPP_JOBS");
        PlayerSettings.SetAdditionalIl2CppArgs("--jobs=" + (string.IsNullOrEmpty(jobs) ? "4" : jobs));
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
        PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
        PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
        PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel32;
        PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
        PlayerSettings.colorSpace = ColorSpace.Linear;
        PlayerSettings.Android.textureCompressionFormats = new[] { TextureCompressionFormat.ASTC };
        EditorUserBuildSettings.development = false;
        EditorUserBuildSettings.buildAppBundle = false;
        EditorUserBuildSettings.exportAsGoogleAndroidProject = false;

        var aih = ProjectSettingsObject().FindProperty("activeInputHandler");
        if (aih == null || aih.intValue != 1)
            throw new Exception("activeInputHandler is " + (aih == null ? "missing" : aih.intValue.ToString()) + ", not 1 — run VCProbeBuild.Prepare first");

        var apis = PlayerSettings.GetGraphicsAPIs(BuildTarget.Android);
        Probe("vulkan", apis.Length == 1 && apis[0] == GraphicsDeviceType.Vulkan, string.Join(",", apis));
        Log("player: IL2CPP ARM64 Vulkan minSdk 32 " + kPackage);
    }

    static void ConfigureUrp()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Settings")) AssetDatabase.CreateFolder("Assets", "Settings");
        const string rendererPath = "Assets/Settings/ProbeRenderer.asset", assetPath = "Assets/Settings/ProbeURP.asset";
        var rendererData = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(rendererPath);
        if (rendererData == null)
        {
            rendererData = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(rendererData, rendererPath);
        }
        var asset = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(assetPath);
        if (asset == null)
        {
            asset = UniversalRenderPipelineAsset.Create(rendererData);
            AssetDatabase.CreateAsset(asset, assetPath);
        }
        asset.msaaSampleCount = 4;
        asset.supportsHDR = false;
        EditorUtility.SetDirty(asset);
        AssetDatabase.SaveAssets();

        GraphicsSettings.defaultRenderPipeline = asset;
        int current = QualitySettings.GetQualityLevel();
        for (int i = 0; i < QualitySettings.names.Length; i++)
        {
            QualitySettings.SetQualityLevel(i, false);
            QualitySettings.renderPipeline = asset;
        }
        QualitySettings.SetQualityLevel(current, false);

        // URP's global settings asset (normally made by the editor UI): Ensure() is internal in URP 17.
        var gsType = typeof(UniversalRenderPipelineAsset).Assembly.GetType("UnityEngine.Rendering.Universal.UniversalRenderPipelineGlobalSettings");
        var ensure = gsType?.GetMethod("Ensure", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public);
        if (ensure != null) ensure.Invoke(null, new object[] { true });
        Probe("urp", GraphicsSettings.defaultRenderPipeline is UniversalRenderPipelineAsset, asset.GetType().Name);
    }

    static void ConfigureXrManagement()
    {
        EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.k_SettingsKey, out XRGeneralSettingsPerBuildTarget perTarget);
        if (perTarget == null)
        {
            if (!AssetDatabase.IsValidFolder("Assets/XR")) AssetDatabase.CreateFolder("Assets", "XR");
            perTarget = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
            AssetDatabase.CreateAsset(perTarget, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
            AssetDatabase.SaveAssets();
        }
        EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, perTarget, true);
        if (!perTarget.HasSettingsForBuildTarget(kGroup)) perTarget.CreateDefaultSettingsForBuildTarget(kGroup);
        if (!perTarget.HasManagerSettingsForBuildTarget(kGroup)) perTarget.CreateDefaultManagerSettingsForBuildTarget(kGroup);
        var general = perTarget.SettingsForBuildTarget(kGroup);
        general.InitManagerOnStart = true;
        var manager = general.Manager;
        foreach (var other in manager.activeLoaders.Where(l => l != null && l.GetType().FullName != kOpenXRLoader).ToList())
            manager.TryRemoveLoader(other);
        if (!XRPackageMetadataStore.AssignLoader(manager, kOpenXRLoader, kGroup))
            throw new Exception("AssignLoader(OpenXRLoader, Android) failed");
        EditorUtility.SetDirty(general);
        EditorUtility.SetDirty(manager);
        EditorUtility.SetDirty(perTarget);
        AssetDatabase.SaveAssets();
        Log("XR: Android loaders = " + string.Join(",", manager.activeLoaders.Select(l => l.GetType().Name)));
    }

    static readonly Type[] kWantedFeatures = { typeof(MetaQuestFeature), typeof(OculusTouchControllerProfile) };

    static void ConfigureOpenXr()
    {
        FeatureHelpers.RefreshFeatures(kGroup);
        var settings = OpenXRSettings.GetSettingsForBuildTargetGroup(kGroup);
        if (settings == null) throw new Exception("no OpenXRSettings for Android");
        // Feature sets off, so they do not lock unrelated features on.
        OpenXRFeatureSetManager.InitializeFeatureSets();
        foreach (var fs in OpenXRFeatureSetManager.FeatureSetsForBuildTarget(kGroup)) fs.isEnabled = false;
        OpenXRFeatureSetManager.SetFeaturesFromEnabledFeatureSets(kGroup);

        settings.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced; // multiview on Android
        foreach (var f in settings.GetFeatures())
        {
            if (f == null) continue;
            f.enabled = kWantedFeatures.Contains(f.GetType());
            EditorUtility.SetDirty(f);
        }
        EditorUtility.SetDirty(settings);
        AssetDatabase.SaveAssets();

        // What OpenXR's own build check would refuse: fix what it can fix by itself.
        var issues = new List<OpenXRFeature.ValidationRule>();
        OpenXRProjectValidation.GetCurrentValidationIssues(issues, kGroup);
        foreach (var i in issues.Where(i => i.error && i.fixIt != null && i.fixItAutomatic))
        {
            Log("OpenXR validation fix: " + i.message);
            i.fixIt();
        }
        AssetDatabase.SaveAssets();
        issues.Clear();
        OpenXRProjectValidation.GetCurrentValidationIssues(issues, kGroup);
        foreach (var i in issues) Log("OpenXR validation " + (i.error ? "ERROR" : "warn") + ": " + i.message);

        var quest = settings.GetFeature<MetaQuestFeature>();
        bool features = kWantedFeatures.All(t => settings.GetFeature(t) != null && settings.GetFeature(t).enabled);
        int errors = issues.Count(i => i.error);
        Probe("openxr", features && errors == 0,
            "MetaQuestFeature=" + (quest != null && quest.enabled) + " validationErrors=" + errors);
        Probe("multiview", settings.renderMode == OpenXRSettings.RenderMode.SinglePassInstanced, settings.renderMode.ToString());
    }

    // The Rust cdylib probe.sh copied in: arm64-v8a for the player, x86_64 for the editor.
    static bool ConfigureRustPlugins()
    {
        const string android = "Assets/Plugins/Android/arm64-v8a/libvc_probe.so";
        const string host = "Assets/Plugins/x86_64/libvc_probe.so";
        AssetDatabase.Refresh();
        bool any = false;
        if (AssetImporter.GetAtPath(android) is PluginImporter a)
        {
            a.SetCompatibleWithAnyPlatform(false);
            a.SetCompatibleWithEditor(false);
            a.SetCompatibleWithPlatform(BuildTarget.Android, true);
            a.SetPlatformData(BuildTarget.Android, "CPU", "ARM64");
            a.SaveAndReimport();
            any = true;
        }
        if (AssetImporter.GetAtPath(host) is PluginImporter hst)
        {
            hst.SetCompatibleWithAnyPlatform(false);
            hst.SetCompatibleWithPlatform(BuildTarget.Android, false);
            hst.SetCompatibleWithEditor(true);
            hst.SetEditorData("CPU", "x86_64");
            hst.SetEditorData("OS", "Linux");
            hst.SaveAndReimport();
        }
        Log("rust plugins: android=" + File.Exists(android) + " host=" + File.Exists(host));
        return any || File.Exists(host);
    }

    static void CallRustFromEditor()
    {
        if (!File.Exists("Assets/Plugins/x86_64/libvc_probe.so")) return;
        try
        {
            int r = VCProbeRust.Add(2, 3);
            Probe("rust_editor", r == 5, "vc_probe_add(2, 3) = " + r);
        }
        catch (Exception e) { Probe("rust_editor", false, e.GetType().Name + ": " + e.Message); }
    }

    static void CreateScene()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Scenes")) AssetDatabase.CreateFolder("Assets", "Scenes");
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var cam = new GameObject("Main Camera", typeof(Camera));
        cam.tag = "MainCamera";
        cam.transform.position = new Vector3(0, 1.6f, 0);
        var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        cube.transform.position = new Vector3(0, 1.5f, 2f);
        cube.transform.localScale = Vector3.one * 0.3f;
        new GameObject("Rust", typeof(VCProbeRust));
        if (!EditorSceneManager.SaveScene(scene, kScenePath)) throw new Exception("SaveScene failed");
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(kScenePath, true) };
    }
}
