# Urgent does not bypass WIP limits

`urgent` changes queue order and lets work start outside windows and past the weekly stop (up to the hard stop), but never past `wip.proposalsInReview`/`wip.prsInReview`. Review capacity is the owner's bottleneck; urgency doesn't create more of it.
