// The probe's P/Invoke into the Rust cdylib (libvc_probe.so: arm64-v8a in the
// APK, x86_64 for the editor), as a Quest app calls its native code.
using System.Runtime.InteropServices;
using UnityEngine;

public class VCProbeRust : MonoBehaviour
{
    [DllImport("vc_probe")]
    static extern int vc_probe_add(int a, int b);

    public static int Add(int a, int b) => vc_probe_add(a, b);

    void Start()
    {
        Debug.Log("[VCProbe] vc_probe_add(2, 3) = " + Add(2, 3));
    }
}
