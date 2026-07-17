---
id: rolling-back-a-bad-release
title: "Rolling Back a Bad Release"
title_ja: "不具合リリースの巻き戻し"
domain: it
level: [5, 6]
format: dialogue
speakers: "Emma, Ken"
---

Emma: Ken, did you see the alerts? The app's throwing errors everywhere.

Ken: Yeah, I just noticed. It started right after this morning's release.

Emma: So the new version broke something. Do we know what exactly?

Ken: Not yet. The login page keeps failing for about half the users.

Emma: That's bad. We can't leave it like this for long.

Ken: Agreed. I think we should roll back to the last stable version.

Emma: Okay. Do you remember which build was the good one?

Ken: The one from yesterday afternoon. It ran fine all night.

Emma: Right. Let's not try to fix it live under pressure.

Ken: Exactly. A quick rollback now, then we debug calmly later.

Emma: I'll tell the team in the channel so nobody panics.

Ken: Good idea. I'm starting the rollback from the dashboard now.

Emma: How long does it usually take to switch back?

Ken: About three minutes. It just swaps the running version.

Emma: Okay, I'll keep watching the error graph while it runs.

Ken: Perfect. The old build is deploying. Give it a moment.

Emma: The errors are dropping already. That's a huge relief.

Ken: Nice. Login looks healthy again on my side too.

Emma: Great. So now we need to find the real cause.

Ken: I think it's the new session code we merged yesterday.

Emma: Maybe. Let's check the logs from right before the crash.

Ken: I'll pull them now. There should be a clear error trace.

Emma: Should we also write a short note for the customers?

Ken: Yes, a simple message. Say we fixed a brief login problem.

Emma: I'll draft it. Keep it honest but not too technical.

Ken: Sounds good. And let's add a test for this case.

Emma: Definitely. We don't want the same bug to sneak back.

Ken: Right. Next time we'll catch it before the release goes out.

Emma: Thanks for staying calm, Ken. That was a smooth recovery.

Ken: Teamwork. Now let's grab a coffee before the next fire.
