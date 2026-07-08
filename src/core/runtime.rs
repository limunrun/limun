//! Process-global tokio Handle + bridge channel sender.
//! The receiver lives on the V8 (main) thread in a thread-local set up
//! by `event_loop::set_bridge_rx`; the handle is reachable from any V8
//! callback (which can't capture state — they're bare extern "C" fns).

use std::sync::OnceLock;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

use crate::core::bridge::TaskResult;

static HANDLE: OnceLock<Handle> = OnceLock::new();
static TX: OnceLock<mpsc::UnboundedSender<TaskResult>> = OnceLock::new();

pub fn handle() -> &'static Handle {
    HANDLE.get().expect("tokio runtime not initialized")
}

pub fn tx() -> &'static mpsc::UnboundedSender<TaskResult> {
    TX.get().expect("bridge not initialized")
}

pub fn init(handle: Handle) -> mpsc::UnboundedReceiver<TaskResult> {
    let (tx, rx) = mpsc::unbounded_channel();
    HANDLE.set(handle).expect("runtime::init called twice");
    TX.set(tx).expect("runtime::init called twice");
    rx
}