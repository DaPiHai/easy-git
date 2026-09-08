//! eg-safety: the safety engine behind "every operation is reversible".
//! Scope per TDD §4.3: operation log (JSONL), pre-operation snapshot points,
//! undo/redo, trash refs (`refs/easy-git/trash`), crash recovery.
//! Implemented in W9 (m1-plan R-25); every destructive operation in M1 must
//! route through it and ship an undo test.
