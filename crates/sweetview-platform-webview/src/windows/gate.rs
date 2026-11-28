//! When a script the host asked for after a navigation may go to WebView2
//! (D21): once the navigation the host sent last has its document or has
//! ended. WebView2's `Navigate` hands back no navigation id, so the host's
//! navigations are known by their order: each raises its own
//! `NavigationStarting`, in the order sent, and the events of one the host
//! sent before the last are ignored (measured: `navigate(a); navigate(b)`
//! raised `a`'s start and even its `ContentLoading` before `b` started). A
//! navigation within the document (only the fragment changes) raises no
//! events and is not counted; one WebView2 refuses is taken back.

#[derive(Default, Debug)]
pub(super) struct Gate {
    waiting: bool,
    /// Host navigations sent since the gate closed, and how many have started.
    sent: u32,
    starts: u32,
    awaited: Option<u64>,
    latest: Option<u64>,
}

impl Gate {
    /// The host is sending a navigation; `within` when it stays in the
    /// document, so no event will come for it.
    pub(super) fn sent(&mut self, within: bool) {
        if within {
            return;
        }
        if !self.waiting {
            *self = Self { waiting: true, latest: self.latest, ..Self::default() };
        }
        self.sent += 1;
    }

    /// The navigation just sent was refused by WebView2: nothing will start
    /// for it. True when the gate opens now.
    pub(super) fn refused(&mut self) -> bool {
        if !self.waiting {
            return false;
        }
        self.sent = self.sent.saturating_sub(1);
        if self.sent == 0 {
            self.waiting = false;
            return true;
        }
        if self.starts >= self.sent && self.awaited.is_none() {
            self.awaited = self.latest;
        }
        false
    }

    /// True while a script must wait.
    pub(super) fn waiting(&self) -> bool {
        self.waiting
    }

    /// `NavigationStarting` for `id`.
    pub(super) fn started(&mut self, id: u64) {
        self.latest = Some(id);
        if self.waiting {
            self.starts += 1;
            // The start of the navigation sent last (or a later one, which the page began).
            if self.starts >= self.sent {
                self.awaited = Some(id);
            }
        }
    }

    /// `ContentLoading` (`cancelled` false) or `NavigationCompleted` for
    /// `id`. True when the gate opens now.
    pub(super) fn arrived(&mut self, id: u64, cancelled: bool) -> bool {
        if !self.waiting || self.awaited != Some(id) {
            return false;
        }
        if cancelled && self.latest.is_some() && self.latest != Some(id) {
            self.awaited = self.latest;
            return false;
        }
        self.waiting = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_opens_at_the_document_of_the_navigation_sent() {
        let mut gate = Gate::default();
        gate.sent(false);
        assert!(gate.waiting());
        gate.started(1);
        assert!(gate.arrived(1, false), "ContentLoading of the navigation sent");
        assert!(!gate.waiting());
    }

    #[test]
    fn a_start_raised_while_the_navigation_is_being_sent_is_kept() {
        // WebView2 may raise NavigationStarting inside the `Navigate` call; nothing after a
        // successful call may forget it (the second `sent` the engine used to make did).
        let mut gate = Gate::default();
        gate.sent(false);
        gate.started(1);
        assert!(gate.arrived(1, false));
    }

    #[test]
    fn a_navigation_within_the_document_holds_nothing() {
        let mut gate = Gate::default();
        gate.sent(true);
        assert!(!gate.waiting(), "no event will come for a fragment navigation");
    }

    #[test]
    fn the_events_of_a_navigation_sent_before_the_last_are_ignored() {
        // As measured: both start, and the first even has its document, before the second.
        let mut gate = Gate::default();
        gate.sent(false);
        gate.sent(false);
        gate.started(1);
        assert!(!gate.arrived(1, false), "the first one's document is not the one asked for");
        assert!(!gate.arrived(1, true), "nor its end");
        gate.started(2);
        assert!(gate.arrived(2, false), "the second one's document opens it");
    }

    #[test]
    fn a_navigation_cut_off_by_a_newer_one_hands_the_wait_on() {
        let mut gate = Gate::default();
        gate.sent(false);
        gate.started(1);
        gate.started(2);
        assert!(!gate.arrived(1, true), "cut off by the page's navigation");
        assert!(gate.arrived(2, false));
    }

    #[test]
    fn a_navigation_that_ends_without_a_newer_one_opens_it() {
        let mut gate = Gate::default();
        gate.sent(false);
        gate.started(1);
        assert!(gate.arrived(1, true), "cancelled by nothing newer (a stop): nothing more will come");
    }

    #[test]
    fn a_refused_navigation_is_taken_back() {
        let mut gate = Gate::default();
        gate.sent(false);
        assert!(gate.refused(), "nothing will start: the gate opens");
        let mut gate = Gate::default();
        gate.sent(false);
        gate.sent(false);
        assert!(!gate.refused(), "the first one is still on its way");
        gate.started(1);
        assert!(gate.arrived(1, false));
    }
}
