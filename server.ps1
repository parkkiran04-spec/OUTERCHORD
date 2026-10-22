# xgradation - one local server for the main index and every piece
#   run:  double-click start.bat   (or: powershell -ExecutionPolicy Bypass -File server.ps1)
#   open: http://localhost:8765/
#
# Each piece keeps its own sound-memory API, moved under its folder so they no longer collide:
#   /cattlemutilation/api/sounds        GET ?since&limit | POST [events] | DELETE   -> cattlemutilation/data/sound-memory.jsonl
#   /cattlemutilation/api/sounds/latest
#   /e/api/sounds                       GET | POST {session, events}                -> e/sound-data/sounds.jsonl
#   /d/api/sounds  /d/api/stats  /d/api/archive  /d/api/archives                   -> d/sound-data/sounds-YYYY-MM-DD.jsonl
#   /imnota/api/sounds  /imnota/api/sounds/dates  /imnota/api/sounds/<date>         -> imnota/sound-archive/YYYY-MM-DD.jsonl
#   /tenshi/memory                      GET | POST                                  -> tenshi/memory/sounds.jsonl
#   /c3/api/sounds                      GET | POST {session, events}                -> c3/sound-data/sounds.jsonl
#   /outerchord/api/sound-log           GET | POST one event per request            -> outerchord/sound-data/sound-log.jsonl
#   /api/reset                          POST  moves all of the above to archive/<time>/ (make chord calls it)
#   /api/songs                          GET | POST  the songs make chord has made     -> songs/songs.jsonl
#   /api/comments                       GET | POST  what visitors sent to the comment wall -> comments/data/comments.jsonl
#   everything else                     static files from this folder
param([int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$utf8 = New-Object Text.UTF8Encoding($false)

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.jsonl' = 'application/x-ndjson; charset=utf-8'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'
  '.ico' = 'image/x-icon'; '.gif' = 'image/gif'; '.mp3' = 'audio/mpeg'; '.wav' = 'audio/wav'; '.mp4' = 'video/mp4'
  '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.otf' = 'font/otf'; '.ttf' = 'font/ttf'; '.pdf' = 'application/pdf'
}

# ---------- response helpers ----------
function Send($ctx, [int]$code, [string]$type, [byte[]]$body, [string]$fileName = $null) {
  $r = $ctx.Response
  $r.StatusCode = $code
  $r.Headers['Access-Control-Allow-Origin'] = '*'
  $r.Headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
  $r.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
  $r.Headers['Cache-Control'] = 'no-store'
  if ($fileName) { $r.Headers['Content-Disposition'] = "attachment; filename=`"$fileName`"" }
  if ($type) { $r.ContentType = $type }
  if ($body -and $body.Length) {
    $r.ContentLength64 = $body.Length
    if ($ctx.Request.HttpMethod -ne 'HEAD') { $r.OutputStream.Write($body, 0, $body.Length) }
  }
}
function SendText($ctx, [int]$code, [string]$json) { Send $ctx $code 'application/json; charset=utf-8' ($utf8.GetBytes($json)) }
function SendObj($ctx, [int]$code, $obj) { SendText $ctx $code (ConvertTo-Json -InputObject $obj -Compress -Depth 6) }
function ReadBody($req) {
  $sr = New-Object IO.StreamReader($req.InputStream, $utf8)
  $t = $sr.ReadToEnd(); $sr.Close(); return $t
}

# =====================================================================
# cattlemutilation
# =====================================================================
$cmData = Join-Path $root 'cattlemutilation\data'
New-Item -ItemType Directory -Force $cmData | Out-Null
$cmStore = Join-Path $cmData 'sound-memory.jsonl'
$cmLines = New-Object System.Collections.Generic.List[string]
$cmIds = New-Object System.Collections.Generic.List[long]
$script:cmLast = [long]0
if (Test-Path $cmStore) {
  foreach ($ln in [IO.File]::ReadAllLines($cmStore, $utf8)) {
    if ($ln.Trim() -eq '') { continue }
    $m = [regex]::Match($ln, '"id":(\d+)')
    if ($m.Success) { $id = [long]$m.Groups[1].Value; $cmLines.Add($ln); $cmIds.Add($id); if ($id -gt $script:cmLast) { $script:cmLast = $id } }
  }
}

function Handle-Cattle($ctx, [string]$sub) {
  $req = $ctx.Request
  if ($sub -eq '/api/sounds/latest') { SendText $ctx 200 ('{"last":' + $script:cmLast + ',"count":' + $cmLines.Count + '}'); return $true }
  if ($sub -ne '/api/sounds') { return $false }
  if ($req.HttpMethod -eq 'POST') {
    $items = @((ConvertFrom-Json (ReadBody $req)) | ForEach-Object { $_ })   # PS 5.1 hands a JSON array back as one object
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $new = @()
    foreach ($it in $items) {
      if ($null -eq $it) { continue }
      $script:cmLast++
      $it | Add-Member -NotePropertyName id -NotePropertyValue $script:cmLast -Force
      $it | Add-Member -NotePropertyName st -NotePropertyValue $now -Force
      $line = ConvertTo-Json $it -Compress -Depth 6
      $cmLines.Add($line); $cmIds.Add($script:cmLast); $new += $line
    }
    if ($new.Count) { [IO.File]::AppendAllText($cmStore, (($new -join "`n") + "`n"), $utf8) }
    SendText $ctx 200 ('{"ok":true,"added":' + $new.Count + ',"last":' + $script:cmLast + '}')
  }
  elseif ($req.HttpMethod -eq 'GET') {
    $since = [long]0; $limit = 5000
    if ($req.QueryString['since']) { $since = [long]$req.QueryString['since'] }
    if ($req.QueryString['limit']) { $limit = [int]$req.QueryString['limit'] }
    $lo = 0; $hi = $cmIds.Count
    while ($lo -lt $hi) { $mid = [int][Math]::Floor(($lo + $hi) / 2); if ($cmIds[$mid] -le $since) { $lo = $mid + 1 } else { $hi = $mid } }
    $n = [Math]::Min($limit, $cmLines.Count - $lo)
    $out = if ($n -gt 0) { $cmLines.GetRange($lo, $n) } else { @() }
    SendText $ctx 200 ('[' + ($out -join ',') + ']')
  }
  elseif ($req.HttpMethod -eq 'DELETE') {
    # nothing is lost: the current file is set aside with a timestamp
    if (Test-Path $cmStore) { Move-Item $cmStore (Join-Path $cmData ('sound-memory-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.jsonl')) }
    $cmLines.Clear(); $cmIds.Clear()
    SendText $ctx 200 '{"ok":true}'
  }
  else { SendText $ctx 405 '{"error":"method"}' }
  return $true
}

# =====================================================================
# d  (NOCTILUCA)
# =====================================================================
$dData = Join-Path $root 'd\sound-data'
$dArchive = Join-Path $dData 'archives'
New-Item -ItemType Directory -Force -Path $dData, $dArchive | Out-Null

function Get-DLogFiles([string]$archive, [string]$date) {
  $dir = if ($archive) { Join-Path $dArchive ($archive -replace '[^A-Za-z0-9_\-\.]', '_') } else { $dData }
  if (-not (Test-Path $dir)) { return @() }
  $pattern = if ($date -and $date -ne 'all') { "sounds-$date.jsonl" } else { 'sounds-*.jsonl' }
  @(Get-ChildItem -Path $dir -Filter $pattern -File | Sort-Object Name)
}

function Handle-D($ctx, [string]$sub) {
  $req = $ctx.Request; $q = $req.QueryString
  $sub = $sub.TrimEnd('/')

  if ($sub -eq '/api/sounds' -and $req.HttpMethod -eq 'POST') {
    $payload = (ReadBody $req) | ConvertFrom-Json
    $session = if ($payload.session) { [string]$payload.session } else { 'unknown' }
    $file = Join-Path $dData ("sounds-{0}.jsonl" -f (Get-Date -Format 'yyyy-MM-dd'))
    $now = (Get-Date).ToString('o')
    $lines = New-Object Collections.Generic.List[string]
    foreach ($entry in @($payload.entries)) {
      if (-not $entry) { continue }
      $entry | Add-Member -NotePropertyName session -NotePropertyValue $session -Force
      $entry | Add-Member -NotePropertyName receivedAt -NotePropertyValue $now -Force
      $lines.Add(($entry | ConvertTo-Json -Compress -Depth 8))
    }
    if ($lines.Count -gt 0) { [IO.File]::AppendAllText($file, (($lines -join "`n") + "`n"), $utf8) }
    $total = 0
    foreach ($f in (Get-DLogFiles)) { foreach ($ln in [IO.File]::ReadLines($f.FullName)) { if ($ln.Trim()) { $total++ } } }
    SendObj $ctx 200 @{ ok = $true; received = $lines.Count; file = (Split-Path $file -Leaf); total = $total }
    return $true
  }
  if ($sub -eq '/api/sounds' -and $req.HttpMethod -eq 'GET') {
    $since = $q['since']
    $limit = if ($q['limit']) { [int]$q['limit'] } else { 0 }
    $out = New-Object Collections.Generic.List[string]
    foreach ($f in (Get-DLogFiles $q['archive'] $q['date'])) {
      foreach ($line in [IO.File]::ReadLines($f.FullName)) {
        if (-not $line.Trim()) { continue }
        if ($since -and $line -notmatch '"iso":"([^"]+)"') { continue }
        if ($since -and $matches[1] -lt $since) { continue }
        $out.Add($line)
      }
    }
    if ($limit -gt 0 -and $out.Count -gt $limit) { $out = $out.GetRange($out.Count - $limit, $limit) }
    SendText $ctx 200 ('[' + ($out -join ',') + ']')
    return $true
  }
  if ($sub -eq '/api/stats' -and $req.HttpMethod -eq 'GET') {
    $files = Get-DLogFiles $q['archive'] $q['date']
    $count = 0; $notes = @{}; $sources = @{}; $first = $null; $last = $null
    foreach ($f in $files) {
      foreach ($line in [IO.File]::ReadLines($f.FullName)) {
        if (-not $line.Trim()) { continue }
        $count++
        if ($line -match '"note":"([^"]*)"') { $notes[$matches[1]] = 1 + $notes[$matches[1]] }
        if ($line -match '"src":"([^"]*)"') { $sources[$matches[1]] = 1 + $sources[$matches[1]] }
        if ($line -match '"iso":"([^"]+)"') { if (-not $first) { $first = $matches[1] }; $last = $matches[1] }
      }
    }
    SendObj $ctx 200 @{ count = $count; files = @($files | ForEach-Object { $_.Name }); notes = $notes; sources = $sources; first = $first; last = $last }
    return $true
  }
  if ($sub -eq '/api/archive' -and $req.HttpMethod -eq 'POST') {
    $raw = ReadBody $req
    $body = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { $null }
    $name = if ($body -and $body.name) { [string]$body.name } else { 'exhibition-' + (Get-Date -Format 'yyyyMMdd-HHmm') }
    $name = ($name -replace '[^A-Za-z0-9_\-\.]', '_')
    $move = [bool]($body -and $body.move)
    $dest = Join-Path $dArchive $name
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $count = 0
    foreach ($f in (Get-DLogFiles)) {
      foreach ($ln in [IO.File]::ReadLines($f.FullName)) { if ($ln.Trim()) { $count++ } }
      if ($move) { Move-Item $f.FullName -Destination $dest -Force } else { Copy-Item $f.FullName -Destination $dest -Force }
    }
    [IO.File]::WriteAllText((Join-Path $dest 'meta.json'),
      (ConvertTo-Json -Compress -InputObject @{ name = $name; archivedAt = (Get-Date).ToString('o'); entries = $count; moved = $move }), $utf8)
    SendObj $ctx 200 @{ ok = $true; name = $name; entries = $count; moved = $move; path = $dest }
    return $true
  }
  if ($sub -eq '/api/archives' -and $req.HttpMethod -eq 'GET') {
    $list = @()
    foreach ($dir in (Get-ChildItem -Path $dArchive -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
      $metaPath = Join-Path $dir.FullName 'meta.json'
      $meta = if (Test-Path $metaPath) { [IO.File]::ReadAllText($metaPath, $utf8) | ConvertFrom-Json } else { $null }
      $list += @{
        name = $dir.Name
        entries = if ($meta) { $meta.entries } else { 0 }
        archivedAt = if ($meta) { $meta.archivedAt } else { $dir.CreationTime.ToString('o') }
        files = @(Get-ChildItem $dir.FullName -Filter 'sounds-*.jsonl' -File | ForEach-Object { $_.Name })
      }
    }
    SendObj $ctx 200 @($list)
    return $true
  }
  return $false
}

# =====================================================================
# imnota  (I'm Not an Alien)
# =====================================================================
$imArchive = Join-Path $root 'imnota\sound-archive'
New-Item -ItemType Directory -Force $imArchive | Out-Null

function Handle-Imnota($ctx, [string]$sub) {
  $req = $ctx.Request
  if ($sub -eq '/api/sounds' -and $req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 2MB) { SendObj $ctx 413 @{ ok = $false; error = 'too large' }; return $true }
    $data = (ReadBody $req) | ConvertFrom-Json
    $now = Get-Date
    $sb = New-Object Text.StringBuilder
    $n = 0
    foreach ($e in @($data.events)) {
      if ($null -eq $e -or -not $e.type) { continue }
      $e | Add-Member -NotePropertyName rt -NotePropertyValue $now.ToString('o') -Force
      [void]$sb.Append(($e | ConvertTo-Json -Compress -Depth 5)).Append("`n")
      $n++
    }
    if ($n -gt 0) { [IO.File]::AppendAllText((Join-Path $imArchive ($now.ToString('yyyy-MM-dd') + '.jsonl')), $sb.ToString(), $utf8) }
    SendObj $ctx 200 @{ ok = $true; saved = $n }
    return $true
  }
  if ($sub -eq '/api/sounds/dates' -and $req.HttpMethod -eq 'GET') {
    SendObj $ctx 200 @(Get-ChildItem $imArchive -Filter '*.jsonl' | Sort-Object Name | ForEach-Object { $_.BaseName })
    return $true
  }
  if ($sub -match '^/api/sounds/(\d{4}-\d{2}-\d{2})$' -and $req.HttpMethod -eq 'GET') {
    $file = Join-Path $imArchive ($Matches[1] + '.jsonl')
    if (Test-Path $file) { Send $ctx 200 'application/x-ndjson; charset=utf-8' ([IO.File]::ReadAllBytes($file)) ($Matches[1] + '.jsonl') }
    else { SendObj $ctx 404 @{ ok = $false; error = 'no data for that date' } }
    return $true
  }
  return $false
}

# =====================================================================
# tenshi
# =====================================================================
$tsDir = Join-Path $root 'tenshi\memory'
New-Item -ItemType Directory -Force $tsDir | Out-Null
$tsFile = Join-Path $tsDir 'sounds.jsonl'

function Handle-Tenshi($ctx, [string]$sub) {
  if ($sub -ne '/memory') { return $false }
  $req = $ctx.Request
  if ($req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 2MB) { Send $ctx 413 $null $null; return $true }
    $body = ReadBody $req
    $ok = $false
    try {
      $o = $body | ConvertFrom-Json
      $ok = ($o.session.id -match '^[a-z0-9]{1,24}$') -and ($o.events -is [array])
    } catch {}
    if (-not $ok) { Send $ctx 400 $null $null; return $true }
    $line = '{"received":"' + (Get-Date).ToUniversalTime().ToString('o') + '","data":' + ($body -replace "[\r\n]", '') + '}'
    [IO.File]::AppendAllText($tsFile, $line + "`n", $utf8)
    Send $ctx 204 $null $null
  } else {
    $bytes = if (Test-Path $tsFile) { [IO.File]::ReadAllBytes($tsFile) } else { [byte[]]@() }
    Send $ctx 200 'application/x-ndjson; charset=utf-8' $bytes
  }
  return $true
}

# =====================================================================
# e  (Drawn Groove / The Sound of Not the Earth)
# =====================================================================
$eData = Join-Path $root 'e\sound-data'
New-Item -ItemType Directory -Force $eData | Out-Null
$eStore = Join-Path $eData 'sounds.jsonl'

function Handle-E($ctx, [string]$sub) {
  if ($sub -ne '/api/sounds') { return $false }
  return Handle-SessionLog $ctx $eStore
}

# =====================================================================
# c3  (Passacaglia) - same {session, events} shape as e, sent by c3/sound-log.js
# =====================================================================
$c3Data = Join-Path $root 'c3\sound-data'
New-Item -ItemType Directory -Force $c3Data | Out-Null
$c3Store = Join-Path $c3Data 'sounds.jsonl'

function Handle-C3($ctx, [string]$sub) {
  if ($sub -ne '/api/sounds') { return $false }
  return Handle-SessionLog $ctx $c3Store
}

# =====================================================================
# outerchord - the piece POSTs each sound on its own (sendBeacon, one JSON
# object per request) to api/sound-log, as its own serve.ps1 did
# =====================================================================
$ocData = Join-Path $root 'outerchord\sound-data'
New-Item -ItemType Directory -Force $ocData | Out-Null
$ocStore = Join-Path $ocData 'sound-log.jsonl'

function Handle-OuterChord($ctx, [string]$sub) {
  if ($sub -ne '/api/sound-log') { return $false }
  $req = $ctx.Request
  if ($req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 64KB) { Send $ctx 413 $null $null; return $true }
    $body = ReadBody $req
    $o = $null
    try { $o = $body | ConvertFrom-Json } catch {}
    if ($o -and $o.type) {
      $o | Add-Member -NotePropertyName rt -NotePropertyValue ((Get-Date).ToString('o')) -Force
      [IO.File]::AppendAllText($ocStore, (($o | ConvertTo-Json -Compress -Depth 5) + "`n"), $utf8)
    }
    Send $ctx 204 $null $null
  }
  elseif ($req.HttpMethod -eq 'GET') {
    $out = New-Object Collections.Generic.List[string]
    if (Test-Path $ocStore) { foreach ($ln in [IO.File]::ReadLines($ocStore)) { if ($ln.Trim()) { $out.Add($ln) } } }
    SendText $ctx 200 ('[' + ($out -join ',') + ']')
  }
  else { SendText $ctx 405 '{"error":"method"}' }
  return $true
}

# POST {session, events:[...]} -> one line per event in $store; GET -> JSON array
function Handle-SessionLog($ctx, [string]$store) {
  $eStore = $store
  $req = $ctx.Request
  if ($req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 2MB) { SendObj $ctx 413 @{ ok = $false; error = 'too large' }; return $true }
    $data = (ReadBody $req) | ConvertFrom-Json
    $session = if ($data.session) { [string]$data.session } else { 'unknown' }
    $now = (Get-Date).ToString('o')
    $sb = New-Object Text.StringBuilder
    $n = 0
    foreach ($e in @($data.events)) {
      if ($null -eq $e -or -not $e.type) { continue }
      $e | Add-Member -NotePropertyName session -NotePropertyValue $session -Force
      $e | Add-Member -NotePropertyName rt -NotePropertyValue $now -Force
      [void]$sb.Append(($e | ConvertTo-Json -Compress -Depth 5)).Append("`n")
      $n++
    }
    if ($n -gt 0) { [IO.File]::AppendAllText($eStore, $sb.ToString(), $utf8) }
    SendObj $ctx 200 @{ ok = $true; saved = $n }
  }
  elseif ($req.HttpMethod -eq 'GET') {
    $out = New-Object Collections.Generic.List[string]
    if (Test-Path $eStore) { foreach ($ln in [IO.File]::ReadLines($eStore)) { if ($ln.Trim()) { $out.Add($ln) } } }
    SendText $ctx 200 ('[' + ($out -join ',') + ']')
  }
  else { SendText $ctx 405 '{"error":"method"}' }
  return $true
}

# =====================================================================
# song archive  (every song make chord has made; records/ lists them)
#   POST /api/songs  {id, createdAt, code, ...} -> appended to songs/songs.jsonl
#   GET  /api/songs  -> JSON array, one entry per id (the last one written
#                       wins, so a remake replaces its visit's song)
#   Not touched by /api/reset: the songs are the point of the archive.
# =====================================================================
$songDir = Join-Path $root 'songs'
New-Item -ItemType Directory -Force $songDir | Out-Null
$songFile = Join-Path $songDir 'songs.jsonl'

function Handle-Songs($ctx) {
  $req = $ctx.Request
  if ($req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 64KB) { SendObj $ctx 413 @{ ok = $false; error = 'too large' }; return }
    $body = ReadBody $req
    $o = $null
    try { $o = $body | ConvertFrom-Json } catch {}
    if (-not $o -or -not ($o.id -match '^[a-z0-9]{4,32}$') -or -not ($o.code -match '^[A-Z2-7]{8,8000}$')) {
      SendObj $ctx 400 @{ ok = $false; error = 'bad song' }; return
    }
    $o | Add-Member -NotePropertyName savedAt -NotePropertyValue ((Get-Date).ToString('o')) -Force
    [IO.File]::AppendAllText($songFile, (($o | ConvertTo-Json -Compress -Depth 6) + "`n"), $utf8)
    SendObj $ctx 200 @{ ok = $true }
  }
  elseif ($req.HttpMethod -eq 'GET') {
    # keep the last line per id, in the order the ids first appeared
    $byId = [ordered]@{}
    if (Test-Path $songFile) {
      foreach ($ln in [IO.File]::ReadLines($songFile)) {
        if (-not $ln.Trim()) { continue }
        $m = [regex]::Match($ln, '"id":"([a-z0-9]+)"')
        if ($m.Success) { $byId[$m.Groups[1].Value] = $ln }
      }
    }
    SendText $ctx 200 ('[' + (@($byId.Values) -join ',') + ']')
  }
  else { SendText $ctx 405 '{"error":"method"}' }
}

# =====================================================================
# comments  (the comment wall keeps what visitors send from their phones)
#   GET  /api/comments  -> [{id, text, time}]
#   POST /api/comments  {id, text, time}, once per id  -> comments/data/comments.jsonl
#   /api/reset leaves these alone; they are not sound.
# =====================================================================
$cmtDir = Join-Path $root 'comments\data'
New-Item -ItemType Directory -Force $cmtDir | Out-Null
$cmtFile = Join-Path $cmtDir 'comments.jsonl'
$cmtIds = New-Object 'System.Collections.Generic.HashSet[string]'
if (Test-Path $cmtFile) {
  foreach ($ln in [IO.File]::ReadLines($cmtFile)) {
    $m = [regex]::Match($ln, '"id":"([A-Za-z0-9]+)"')
    if ($m.Success) { [void]$cmtIds.Add($m.Groups[1].Value) }
  }
}

function Handle-Comments($ctx) {
  $req = $ctx.Request
  if ($req.HttpMethod -eq 'POST') {
    if ($req.ContentLength64 -gt 4KB) { SendObj $ctx 413 @{ ok = $false; error = 'too large' }; return }
    $o = $null
    try { $o = (ReadBody $req) | ConvertFrom-Json } catch {}
    $text = if ($o -and $o.text) { ([string]$o.text).Trim() } else { '' }
    if (-not $o -or -not ([string]$o.id -match '^[A-Za-z0-9]{6,32}$') -or -not $text -or $text.Length -gt 300) {
      SendObj $ctx 400 @{ ok = $false; error = 'bad comment' }; return
    }
    if ($cmtIds.Add([string]$o.id)) {
      $line = [ordered]@{ id = [string]$o.id; text = $text; time = [long]$o.time; savedAt = (Get-Date).ToString('o') }
      [IO.File]::AppendAllText($cmtFile, ((ConvertTo-Json -InputObject $line -Compress) + "`n"), $utf8)
    }
    SendObj $ctx 200 @{ ok = $true }
  }
  elseif ($req.HttpMethod -eq 'GET') {
    $lines = if (Test-Path $cmtFile) { @([IO.File]::ReadLines($cmtFile) | Where-Object { $_.Trim() }) } else { @() }
    SendText $ctx 200 ('[' + ($lines -join ',') + ']')
  }
  else { SendText $ctx 405 '{"error":"method"}' }
}

# =====================================================================
# reset  (called by "make chord" once it has made its song)
#   POST /api/reset -> every piece's sound files move to archive/<time>/<piece>/
#   and the pieces start collecting from nothing. Nothing is deleted.
# =====================================================================
$archiveRoot = Join-Path $root 'archive'

function Handle-Reset($ctx) {
  if ($ctx.Request.HttpMethod -ne 'POST') { SendText $ctx 405 '{"error":"method"}'; return }
  $name = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest = Join-Path $archiveRoot $name
  $sets = @(
    @{ piece = 'cattlemutilation'; files = @(Get-ChildItem $cmData -Filter 'sound-memory.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'e';                files = @(Get-ChildItem $eData -Filter 'sounds.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'd';                files = @(Get-ChildItem $dData -Filter 'sounds-*.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'imnota';           files = @(Get-ChildItem $imArchive -Filter '*.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'tenshi';           files = @(Get-ChildItem $tsDir -Filter 'sounds.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'c3';               files = @(Get-ChildItem $c3Data -Filter 'sounds.jsonl' -File -ErrorAction SilentlyContinue) },
    @{ piece = 'outerchord';       files = @(Get-ChildItem $ocData -Filter 'sound-log.jsonl' -File -ErrorAction SilentlyContinue) }
  )
  $moved = 0
  foreach ($s in $sets) {
    if (-not $s.files.Count) { continue }
    $to = Join-Path $dest $s.piece
    New-Item -ItemType Directory -Force $to | Out-Null
    foreach ($f in $s.files) { Move-Item $f.FullName -Destination $to -Force; $moved++ }
  }
  # cattle keeps its log in memory as well; ids carry on from where they were
  $cmLines.Clear(); $cmIds.Clear()
  SendObj $ctx 200 @{ ok = $true; archive = $(if ($moved) { $name } else { $null }); files = $moved }
}

# =====================================================================
# listener
# =====================================================================
$l = New-Object Net.HttpListener
try { $l.Prefixes.Add("http://+:$Port/"); $l.Start(); $where = "all network addresses (port $Port)" }
catch { $l = New-Object Net.HttpListener; $l.Prefixes.Add("http://localhost:$Port/"); $l.Start(); $where = "this PC only" }
Write-Host "xgradation server: $where"
Write-Host "  main : http://localhost:$Port/"
Write-Host "  data : cattlemutilation\data, d\sound-data, imnota\sound-archive, tenshi\memory"
Write-Host "  stop : Ctrl+C"

# data folders are written by the server, never served as plain files
$blocked = '^(archive|songs|comments/data|cattlemutilation/data|e/sound-data|c3/sound-data|outerchord/sound-data|d/sound-data|imnota/sound-archive)(/|$)|(^|/)\.|\.ps1$|\.bat$'

while ($l.IsListening) {
  $ctx = $l.GetContext()
  try {
    $req = $ctx.Request
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($req.HttpMethod -eq 'OPTIONS') { Send $ctx 204 $null $null; continue }

    if ($path -eq '/api/reset') { Handle-Reset $ctx; continue }
    if ($path -eq '/api/songs') { Handle-Songs $ctx; continue }
    if ($path -eq '/api/comments') { Handle-Comments $ctx; continue }

    # ---- per-piece APIs ----
    $handled = $false
    if ($path -match '^/(cattlemutilation|e|d|imnota|tenshi|c3|outerchord)(/.*)$') {
      $piece = $Matches[1]; $sub = $Matches[2]
      switch ($piece) {
        'cattlemutilation' { $handled = Handle-Cattle $ctx $sub }
        'e'                { $handled = Handle-E $ctx $sub }
        'c3'               { $handled = Handle-C3 $ctx $sub }
        'outerchord'       { $handled = Handle-OuterChord $ctx $sub }
        'd'                { $handled = Handle-D $ctx $sub }
        'imnota'           { $handled = Handle-Imnota $ctx $sub }
        'tenshi'           { $handled = Handle-Tenshi $ctx $sub }
      }
    }
    if ($handled) { continue }

    # ---- static files ----
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { SendText $ctx 405 '{"error":"method"}'; continue }
    $rel = $path.TrimStart('/')
    if ($rel -match $blocked) { SendText $ctx 404 '{"error":"not found"}'; continue }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { SendText $ctx 404 '{"error":"not found"}'; continue }
    if (Test-Path $full -PathType Container) {
      # /tenshi -> /tenshi/ so the page's relative links resolve inside its folder
      if (-not $path.EndsWith('/')) { $ctx.Response.Redirect($path + '/' + $req.Url.Query); continue }
      $full = Join-Path $full 'index.html'
    }
    if (Test-Path $full -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      Send $ctx 200 $type ([IO.File]::ReadAllBytes($full))
    } else { SendText $ctx 404 '{"error":"not found"}' }
  }
  catch {
    Write-Host "error: $($_.Exception.Message)"
    try { SendText $ctx 500 ('{"error":' + (ConvertTo-Json $_.Exception.Message) + '}') } catch {}
  }
  finally {
    try { $ctx.Response.Close() } catch {}
  }
}
