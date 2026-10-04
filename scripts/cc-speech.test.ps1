# powershell -NoProfile -File scripts\cc-speech.test.ps1
# cc reads its text aloud through Speakable (scripts/cc.ps1); what Kokoro gets wrong comes
# out as nonsense ("wed ox 7" for "Wed, Oct 7", "Brand s" for a curly apostrophe). Checks the
# rewrites on real phrases, with account names and a pronunciation as the desk would send them.
$src = Get-Content (Join-Path $PSScriptRoot "cc.ps1") -Raw
$a = $src.IndexOf('$script:names = @{}'); $b = $src.IndexOf('# Lines are rendered by Kokoro', $a)
$months = (New-Object System.Globalization.CultureInfo "en-US").DateTimeFormat.MonthNames
Invoke-Expression $src.Substring($a, $b - $a)
$script:names = @{ "acme-tiktok" = "Acme"; "acme-shop-tiktok" = "Acme Shop" }
$script:pronounce = @{ "Zyntra" = "Zin-tra" }

$cases = [ordered]@{
  "acme-tiktok-2026-10-06-001 is ready."                   = "Acme's October 6 post is ready."
  "acme-shop-tiktok-2026-10-07-002 is queued."             = "Acme Shop's October 7 post is queued."
  "Pause acme-tiktok for now."                             = "Pause Acme for now."
  "Making Zyntra iOS's Wed, Oct 7 post"                    = "Making Zin-tra iOS's Wednesday, October 7 post"
  "Sun 00:35 cc: the desk server missed 3 polls"           = "Sunday 12:35 AM cc: the desk server missed 3 polls"
  "It posts at 17:30 in W41."                              = "It posts at 5:30 PM in week 41."
  "The latest was at 12:14 PM."                            = "The latest was at 12:14 PM."
  "Acme$([char]0x2019)s video $([char]0x2014) the new one" = "Acme's video, the new one"
  "Answered in 512 ms (cut 2; the newest is cut 3)."       = "Answered in 512 milliseconds, cut 2; the newest is cut 3."
  "Approve/skip it, e.g. now."                             = "Approve or skip it, for example now."
  "Problems:`n- one`n- two"                                = "Problems. one. two"
  "**Done** $([char]0x2705) see https://x.y/z"             = "Done see a link"
  "11 queued - 3 posted"                                   = "11 queued, 3 posted"
  "Nothing on Mon."                                        = "Nothing on Mon."
}
$bad = 0
foreach ($k in $cases.Keys) {
  $got = Speakable $k
  if ($got -cne $cases[$k]) { $bad++; "FAIL: '$k'`n  got:  '$got'`n  want: '$($cases[$k])'" }
}
if ($bad) { exit 1 } else { "speech ok ($($cases.Count) cases)" }
