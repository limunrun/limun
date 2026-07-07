//! Minimal single-threaded event loop: a timer wheel plus microtask
//! draining. This is the only piece of "host-driven async" limun has —
//! `await`/`Promise` themselves need none of this, V8 handles that
//! internally. All we own is: "what's scheduled, when does it fire, and
//! when do we give V8 a chance to run its microtask queue."
//!
//! Backs the `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`
//! globals in `web::timers`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

struct Timer {
    callback: v8::Global<v8::Function>,
    args: Vec<v8::Global<v8::Value>>,
    deadline: Instant,
    /// `Some(interval)` for setInterval; re-armed after firing unless cleared.
    repeat: Option<Duration>,
}

thread_local! {
    static TIMERS: RefCell<HashMap<u32, Timer>> = RefCell::new(HashMap::new());
    /// Marks ids cleared *while their own callback was running* (removed
    /// from TIMERS already, so `clear` has nothing to remove there).
    static CANCELLED: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// Schedule `callback` to run after `delay_ms`. `repeat` = true re-arms it
/// every `delay_ms` (setInterval); false runs it once (setTimeout).
/// Returns the timer handle (what `clearTimeout`/`clearInterval` take).
pub fn schedule(
    callback: v8::Global<v8::Function>,
    args: Vec<v8::Global<v8::Value>>,
    delay_ms: f64,
    repeat: bool,
) -> u32 {
    let delay = Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
    let id = NEXT_ID.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1).max(1));
        id
    });
    let timer = Timer {
        callback,
        args,
        deadline: Instant::now() + delay,
        repeat: repeat.then_some(delay),
    };
    TIMERS.with(|t| t.borrow_mut().insert(id, timer));
    id
}

/// `clearTimeout`/`clearInterval`: cancel a scheduled (or currently-firing,
/// self-cancelling) timer. No-op on unknown ids, matches spec.
pub fn clear(id: u32) {
    let removed = TIMERS.with(|t| t.borrow_mut().remove(&id).is_some());
    if !removed {
        // Either unknown, or it's the timer currently invoking this very
        // call (we remove-before-call, see `run`) — mark it so `run`
        // doesn't re-arm it after the callback returns.
        CANCELLED.with(|c| {
            c.borrow_mut().insert(id);
        });
    }
}

/// Drive the loop: fire due timers, drain microtasks after each, sleep
/// until the next deadline, repeat until nothing is scheduled. Call once,
/// after the entry module's top-level evaluation.
pub fn run(scope: &mut v8::PinScope) {
    // Flush whatever top-level evaluation already queued (e.g. a resolved
    // promise chain that never needed a timer).
    scope.perform_microtask_checkpoint();

    loop {
        let next_deadline = TIMERS.with(|t| t.borrow().values().map(|timer| timer.deadline).min());
        let Some(deadline) = next_deadline else {
            break; // nothing scheduled: done
        };

        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }

        let now = Instant::now();
        let due: Vec<u32> = TIMERS.with(|t| {
            t.borrow()
                .iter()
                .filter(|(_, timer)| timer.deadline <= now)
                .map(|(id, _)| *id)
                .collect()
        });

        for id in due {
            // Remove before calling: makes self-cancellation
            // (`clearInterval` from inside its own callback) detectable via
            // CANCELLED, and guards against re-entrant double-firing.
            let Some(timer) = TIMERS.with(|t| t.borrow_mut().remove(&id)) else {
                continue; // a prior callback in this batch already cleared it
            };

            let func = v8::Local::new(scope, &timer.callback);
            let receiver = v8::undefined(scope).into();
            let args: Vec<v8::Local<v8::Value>> =
                timer.args.iter().map(|a| v8::Local::new(scope, a)).collect();
            func.call(scope, receiver, &args);

            if let Some(interval) = timer.repeat {
                let self_cancelled = CANCELLED.with(|c| c.borrow_mut().remove(&id));
                if !self_cancelled {
                    TIMERS.with(|t| {
                        t.borrow_mut().insert(
                            id,
                            Timer {
                                callback: timer.callback,
                                args: timer.args,
                                deadline: Instant::now() + interval,
                                repeat: Some(interval),
                            },
                        )
                    });
                }
            }

            // Give V8 a chance to run whatever the callback (or its
            // Promise resolutions) queued — including `await` resumptions.
            scope.perform_microtask_checkpoint();
        }
    }
}

/// Drop all pending timers. Must run before the isolate is torn down —
/// `v8::Global` handles inside `Timer` must not outlive it.
pub fn clear_all() {
    TIMERS.with(|t| t.borrow_mut().clear());
    CANCELLED.with(|c| c.borrow_mut().clear());
}
