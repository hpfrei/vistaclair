//! The unity extra's probe cdylib: a plain C ABI that C# reaches by P/Invoke.

#[no_mangle]
pub extern "C" fn vc_probe_add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}
