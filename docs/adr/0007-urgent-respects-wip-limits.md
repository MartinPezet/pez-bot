# Urgent does not bypass WIP limits

`urgent` changes queue order and lets work start outside windows and past the weekly stop (up to the hard stop), but never past the WIP limit (`MAX_PRS_IN_REVIEW`, formerly `wip.prsInReview`; `wip.proposalsInReview` was retired by ADR-0017). Review capacity is the owner's bottleneck; urgency doesn't create more of it.
