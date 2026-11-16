<?php
// The PHP port checked against the protocol package (openresty/test/parity.json,
// what the package answers, read by both ports), plus the reject paths only the
// port has. `php wordpress/test/unit.php` from the repo root, or via run.sh.
require __DIR__ . '/../d3-dna/src/Protocol.php';
require __DIR__ . '/../d3-dna/src/Memory.php';
require __DIR__ . '/../d3-dna/src/InputStream.php';
require __DIR__ . '/../d3-dna/src/Runtime.php';

use D3\Dna\Protocol as P;
use D3\Dna\Runtime;

$failed = 0;
$passed = 0;

function check($name, $ok, $detail = null)
{
    global $failed, $passed;
    if ($ok) {
        $passed++;
        return;
    }

    $failed++;
    echo "  FAIL $name" . ($detail === null ? '' : "\n       " . substr(is_string($detail) ? $detail : json_encode($detail), 0, 600)) . "\n";
}

// A notice the port printed would send WordPress's headers early, so any one is a failure. @ still silences.
set_error_handler(function ($level, $message, $file, $line) {
    if (!(error_reporting() & $level)) return false;
    check('no PHP notice: ' . $message . ' at ' . basename($file) . ":$line", false);
    return true;
});

function is_list_array(array $a)
{
    return $a === [] || array_keys($a) === range(0, count($a) - 1);
}

/** Objects and assoc arrays alike, keys sorted, null and absent the same; integral floats as ints. */
function canonical($v)
{
    if ($v instanceof stdClass) $v = get_object_vars($v);
    if ($v === null) return 'null';
    if (is_bool($v)) return $v ? 'true' : 'false';
    if (is_float($v) && floor($v) === $v && abs($v) < 1e15) return (string) (int) $v;
    if (is_int($v) || is_float($v)) return json_encode($v);
    if (is_string($v)) return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (is_list_array($v)) return '[' . implode(',', array_map('canonical', $v)) . ']';

    ksort($v, SORT_STRING);
    $parts = [];
    foreach ($v as $k => $inner) {
        if ($inner !== null) $parts[] = $k . '=' . canonical($inner);
    }
    return '{' . implode(',', $parts) . '}';
}

function same($name, $got, $want)
{
    $g = canonical($got);
    $w = canonical($want);
    check($name, $g === $w, "got  " . substr($g, 0, 400) . "\n       want " . substr($w, 0, 400));
}

/**
 * JSON as it is on the wire: an object is not an array, and a null field is not
 * an absent one. For what the port writes as JSON, where `{}` against `[]` is the
 * bug PHP is prone to.
 */
function wire($v)
{
    if ($v instanceof stdClass) {
        $keys = array_keys(get_object_vars($v));
        sort($keys, SORT_STRING);
        return '{' . implode(',', array_map(function ($k) use ($v) {
            return json_encode((string) $k) . ':' . wire($v->{$k});
        }, $keys)) . '}';
    }
    if (is_array($v)) return '[' . implode(',', array_map('wire', $v)) . ']';
    if (is_float($v) && floor($v) === $v && abs($v) < 1e15) return (string) (int) $v;
    return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

/** $got is JSON text the port wrote (or null); $want is the package's value. */
function exact($name, $got, $want)
{
    $g = $got === null ? 'null' : wire(json_decode($got));
    $w = wire($want);
    check($name, $g === $w, "got  " . substr($g, 0, 400) . "\n       want " . substr($w, 0, 400));
}

/** `{ $repeat, n }` back to the long run parity.spec.ts compacted it from. */
function expand($v)
{
    if ($v instanceof stdClass) {
        if (isset($v->{'$repeat'}) && is_string($v->{'$repeat'})) return str_repeat($v->{'$repeat'}, $v->n);
        foreach (get_object_vars($v) as $k => $inner) $v->{$k} = expand($inner);
        return $v;
    }
    if (is_array($v)) return array_map('expand', $v);
    return $v;
}

function to_array($v)
{
    return json_decode(json_encode($v), true);
}

$parity = expand(json_decode(file_get_contents(__DIR__ . '/../../openresty/test/parity.json')));
// A section the file lost would otherwise run no checks and pass.
foreach (['constants', 'forwardAll', 'withheld', 'exclusionList', 'privateCacheControl', 'cookies', 'payParams', 'mcp', 'answers',
    'results', 'exclusionOverflow', 'unreadableAnswers', 'edgeModes', 'recordableName', 'debugHeaders', 'settings'] as $section) {
    if (empty($parity->{$section})) {
        echo "parity.json has no $section section\n";
        exit(1);
    }
}

/** What fetch's Headers makes of the pairs: lowercase names, repeats joined. */
function raw_headers(array $pairs)
{
    $raw = [];
    foreach ($pairs as $pair) {
        $name = strtolower($pair[0]);
        $raw[$name][] = $pair[1];
    }
    return $raw;
}

function entries_of(array $pairs)
{
    return P::headerEntries(raw_headers($pairs));
}

function headers_object(array $list)
{
    $out = [];
    foreach ($list as $pair) $out[strtolower($pair[0])] = $pair[1];
    return $out;
}

function decoded($s)
{
    return $s === null ? null : P::jsonDecode($s);
}

// ── Parity ───────────────────────────────────────────────────────────────────

$c = $parity->constants;
same('constants: ADAPTER_SET', P::ADAPTER_SET, $c->ADAPTER_SET);
same('constants: FORWARDED_HEADER_SET', P::FORWARDED_HEADER_SET, $c->FORWARDED_HEADER_SET);
same('constants: FORWARDED_HEADERS', P::FORWARDED_HEADERS, $c->FORWARDED_HEADERS);
same('constants: HEADER_LENGTH_CAPS', P::HEADER_LENGTH_CAPS, $c->HEADER_LENGTH_CAPS);
same('constants: NEVER_FORWARDED_HEADERS', P::NEVER_FORWARDED_HEADERS, $c->NEVER_FORWARDED_HEADERS);
same('constants: MCP_KEY_ARGUMENT_SCHEMA', P::mcpKeyArgumentSchema(), $c->MCP_KEY_ARGUMENT_SCHEMA);

foreach ($parity->forwardAll as $case) {
    same('forwardAll: ' . $case->name, P::forwardAll(entries_of($case->headers), to_array($case->exclude), P::HEADER_LENGTH_CAPS), $case->out);
}

foreach ($parity->withheld as $case) {
    same('withheldOf: ' . $case->name, P::withheldOf(to_array($case->exclude), to_array($case->unlisted)), $case->out);
}

foreach ($parity->exclusionList as $case) {
    same('parseExclusionList: ' . json_encode($case->raw) . ' ' . json_encode($case->lowercase), P::parseExclusionList($case->raw, $case->lowercase), $case->out);
}

foreach ($parity->privateCacheControl as $case) {
    same('privateCacheControl: ' . json_encode($case->origin), P::privateCacheControl($case->origin), $case->out);
}

foreach ($parity->cookies as $case) {
    same('cookiesOf: ' . $case->header, P::cookiesOf($case->header), $case->cookiesOf);
    same('readCookie session: ' . $case->header, P::readCookie($case->header, '__Host-d3pay'), $case->readSession);
    same('readCookie person: ' . $case->header, P::readCookie($case->header, '__Host-d3person'), $case->readPerson);
    if ($case->header !== '') same('stripOwnCookies: ' . $case->header, P::stripOwnCookies($case->header), $case->stripOwn);
}

foreach ($parity->payParams as $case) {
    same('stripPayParams: ' . $case->url, P::stripPayParams($case->url), $case->out);
}

/** A base64 credential is compared by the JSON inside it: both sides re-serialize. */
function lifted_view($lifted)
{
    $out = [];
    foreach ((array) $lifted as $name => $value) {
        $out[$name] = $name === 'payment-signature' ? (P::jsonDecode(base64_decode($value)) ?? $value) : $value;
    }
    return $out;
}

foreach ($parity->mcp as $case) {
    $body = $case->body;
    if (isset($case->blobBytes)) $body = str_replace('@BLOB@', str_repeat('x', $case->blobBytes), $body);
    $raw = array_map(function ($values) {
        return implode(', ', $values);
    }, raw_headers($case->headers));
    $get = function ($name) use ($raw) {
        return $raw[$name] ?? null;
    };
    $carriage = P::mcpCarriageOf($case->method, $get, $case->method === 'GET' ? '' : $body, $case->excluded);
    $label = 'mcp: ' . $case->name;
    $rpc = $carriage['rpc'] === null ? null
        : ['id' => $carriage['rpc']['id'], 'method' => $carriage['rpc']['method'], 'params' => $carriage['rpc']['params']];
    same("$label (rpc)", $rpc, $case->rpc);
    same("$label (facts)", $carriage['facts'], $case->facts);
    same("$label (lifted)", lifted_view($carriage['lifted']), lifted_view($case->lifted));
    exact("$label (origin body)", $carriage['origin_body'], $case->originBody);
    same("$label (unreadable)", $carriage['unreadable_credential'], $case->unreadableCredential);
    same("$label (why)", $carriage['unreadable_reason'], $case->unreadableReason);
    same("$label (forwarded)", lifted_view(P::liftedPaymentToForward($raw, $carriage['lifted'])), lifted_view($case->forwarded));
}

foreach ($parity->answers as $case) {
    $status = $case->payment->status ?? 502;
    $mode = P::paymentEdgeMode(is_int($status) ? $status : 502);
    $rpc = property_exists($case, 'rpcId') ? ['hasId' => true, 'id' => $case->rpcId] : null;
    $built = P::buildPaymentAnswer($case->payment, $mode, $rpc);
    $label = 'buildPaymentResponse: ' . $case->name;
    same("$label (status)", $built['status'], $case->status);
    same("$label (headers)", headers_object($built['headers']), $case->headers);
    $want = $case->body ?? null;
    if (P::jsonDecode($want) !== null) {
        exact("$label (body)", $built['body'], P::jsonDecode($want));
    } else {
        same("$label (body)", $built['body'], $want);
    }
}

foreach ($parity->results as $case) {
    $edits = P::mcpResultEdits($case->method ?? null, $case->meta ?? null, $case->keyArgument);
    $rewritten = null;
    if ($edits !== null && P::isJsonType($case->contentType)) $rewritten = P::rewriteResult($case->body, $edits['meta'], $edits['lists_tools']);
    exact('withMcpResult: ' . $case->name, $rewritten, $case->rewritten ?? null);
}

foreach ($parity->exclusionOverflow as $case) {
    $exclude = to_array($case->exclude);
    same('exclusionOverflowWarning: ' . count($exclude['headers']) . '/' . count($exclude['cookies']), P::exclusionOverflowWarning($exclude), $case->out);
}

foreach ($parity->unreadableAnswers as $case) {
    $built = P::unreadableCallAnswer($case->reason);
    same("unreadableCallResponse: {$case->reason} (status)", $built['status'], $case->status);
    same("unreadableCallResponse: {$case->reason} (headers)", headers_object($built['headers']), $case->headers);
    same("unreadableCallResponse: {$case->reason} (body)", decoded($built['body']), decoded($case->body));
}

foreach ($parity->edgeModes as $case) {
    same('paymentEdgeMode: ' . $case->status, P::paymentEdgeMode($case->status), $case->out);
}

foreach ($parity->recordableName as $case) {
    same('recordableName: ' . $case->name, P::recordableName($case->name), $case->out);
}

foreach ($parity->debugHeaders as $case) {
    same('debugHeadersOf: ' . $case->name, P::debugHeadersOf(entries_of($case->headers), $case->excluded), $case->out);
}

foreach ($parity->settings as $case) {
    $env = (array) $case->env;
    $s = P::settings(function ($name) use ($env) {
        return $env[$name] ?? null;
    });
    $want = to_array($case->out);
    // The one deliberate difference: the unpaid budget defaults to DEFAULT_TIMEOUT_MS.
    $timeoutSet = $env['DNA_TIMEOUT_MS'] ?? $env['POLICY_TIMEOUT_MS'] ?? null;
    if (!(is_numeric($timeoutSet) && (float) $timeoutSet > 0)) $want['timeoutMs'] = P::DEFAULT_TIMEOUT_MS;
    same('readAdapterSettings: ' . $case->name, [
        'endpoint' => $s['endpoint'], 'apiKey' => $s['api_key'], 'failMode' => $s['fail_mode'],
        'timeoutMs' => $s['timeout_ms'], 'paymentTimeoutMs' => $s['payment_timeout_ms'],
        'debugLogRawPayload' => $s['debug_log_raw_payload'], 'exclude' => $s['exclude'],
    ], $want);
}

// ── The port's own ───────────────────────────────────────────────────────────

ini_set('serialize_precision', '17');
check('jsonEncode writes 0.1 short whatever serialize_precision says', P::jsonEncode(0.1) === '0.1', P::jsonEncode(0.1));
check('jsonEncode puts serialize_precision back', ini_get('serialize_precision') === '17');
ini_set('serialize_precision', '-1');
foreach ([0.30000000000000004, 9007199254740991, -1.5e-7, 1e21, 5] as $n) {
    check('jsonEncode keeps ' . var_export($n, true), (float) P::jsonEncode($n) === (float) $n, P::jsonEncode($n));
}
check('jsonEncode keeps an empty object an object', P::jsonEncode((object) ['e' => [], 'o' => new stdClass()]) === '{"e":[],"o":{}}');
check('jsonDecode drops a UTF-8 BOM', canonical(P::jsonDecode("\xEF\xBB\xBF{\"a\":1}")) === canonical(['a' => 1]));
check('jsonDecode reads a JSON null as nothing, never a decision', P::jsonDecode('null') === null);
check('jsonDecode refuses what does not parse', P::jsonDecode('{"a":') === null && P::jsonDecode('not json') === null);

check('a header byte past ASCII reaches DNA as the code point fetch reads', P::latin1ToUtf8("caf\xe9") === "caf\u{e9}");
$wire = json_decode(P::encodePayload([
    'url' => '/x', 'host' => 'h', 'headers' => ['x-a' => "\xff"], 'cookies' => [], 'excluded' => ['headers' => [], 'cookies' => []],
]), true);
check('encodePayload keeps an empty cookie jar an object', strpos(P::encodePayload(['url' => '/', 'host' => 'h', 'headers' => [], 'cookies' => []]), '"cookies":{}') !== false);
check('encodePayload sends a header named by digits as a name', strpos(P::encodePayload(['url' => '/', 'host' => 'h', 'headers' => ['0' => 'z']]), '"headers":{"0":"z"}') !== false);
check('encodePayload never fails on a byte that is not UTF-8', $wire['headers']['x-a'] === "\u{ff}", $wire);

// The header check is the last place before PHP's header table.
check('headerSafe drops CRLF in a value', !P::headerSafe('x', "a\r\nb"));
check('headerSafe drops a trailing LF, which $ alone would let through', !P::headerSafe('x', "a\n") && !P::headerSafe("x\n", 'a'));
check('headerSafe drops a space in a name', !P::headerSafe('x y', 'v'));
check('headerSafe drops an empty value', !P::headerSafe('x', ''));
check('headerSafe drops a value past 8192', !P::headerSafe('x', str_repeat('v', 8193)));
check('headerSafe drops a name past 64', !P::headerSafe(str_repeat('n', 65), 'v'));
check('headerSafe drops a non-string', !P::headerSafe('x', 1));
check('headerSafe keeps a token and printable value', P::headerSafe('payment-receipt', 'abc; def=1'));
$unsafe = P::buildPaymentAnswer((object) ['status' => 402, 'headers' => (object) ['x-bad' => "a\r\nset-cookie: evil=1", 'ok' => 'v']], 'payment-required');
check('an unsafe payment header is dropped from the answer', !isset(headers_object($unsafe['headers'])['x-bad']) && headers_object($unsafe['headers'])['ok'] === 'v');
$weird = P::buildPaymentAnswer((object) ['status' => '302', 'body' => 'b'], 'x');
check('a status that is not a number is a 502, never a header PHP guesses', $weird['status'] === 502);

// The handoff, as URLSearchParams reads it.
$handoff = str_repeat('A', 22) . '.' . str_repeat('b', 43);
check('handoff read from the query', P::handoffFromQuery("x=1&d3pay_handoff=$handoff") === $handoff);
check('handoff read under an escaped name', P::handoffFromQuery("d3pay%5Fhandoff=$handoff") === $handoff);
check('a malformed handoff is none', P::handoffFromQuery("d3pay_handoff={$handoff}x") === null);
check('a handoff with a trailing newline is none', P::handoffFromQuery('d3pay_handoff=' . rawurlencode("$handoff\n")) === null);
check('only the first handoff counts', P::handoffFromQuery("d3pay_handoff=bad&d3pay_handoff=$handoff") === null);

// Payment presence picks the budget and the fail-closed answer.
check('a payment header under its cap pays', P::presentsPayment(['x-payment' => 'p'], null, []));
check('a payment header past its cap does not', !P::presentsPayment(['x-payment' => str_repeat('p', 4097)], null, []));
check('our session cookie pays', P::presentsPayment(['cookie' => '__Host-d3pay=' . str_repeat('s', 43)], null, []));
check('an oversized session cookie does not', !P::presentsPayment(['cookie' => '__Host-d3pay=' . str_repeat('s', 65)], null, []));
check('the person pass is not a payment', !P::presentsPayment(['cookie' => '__Host-d3person=p'], null, []));
check('a handoff on the URL pays', P::presentsPayment([], "d3pay_handoff=$handoff", []));
check('a payment lifted onto the payload pays', P::presentsPayment([], null, ['payment-authorization' => 'Payment k']));


check('namespace: a lowercase letter after the prefix is ours', P::isNamespaceCookie('__Host-d3visitor') && P::isNamespaceCookie('__Secure-d3x'));
check("namespace: our apps' own cookies are not", !P::isNamespaceCookie('__Host-d3_session') && !P::isNamespaceCookie('__Secure-d3-x') && !P::isNamespaceCookie('__Host-d3'));
check('namespace: an uppercase letter is not', !P::isNamespaceCookie('__Host-d3Pay'));
$crowd = implode('; ', array_map(function ($i) {
    return "__Host-d3x$i=" . str_repeat('v', 100);
}, range(1, 20))) . '; __Host-d3visitor=V1; ' . implode('; ', array_map(function ($i) {
    return "site$i=" . str_repeat('s', 2000);
}, range(1, 20)));
$crowded = P::forwardAll(entries_of([['cookie', $crowd]]), ['headers' => [], 'cookies' => []], P::HEADER_LENGTH_CAPS);
check('the id we set outlasts cookies wearing our prefix and a jar past the shared cap', ($crowded['cookies']['__Host-d3visitor'] ?? null) === 'V1', array_keys($crowded['cookies']));
check('the rest wearing our prefix stop at eight, unnamed', count(array_filter(array_keys($crowded['cookies']), function ($n) {
    return strncmp($n, '__Host-d3x', 10) === 0;
})) === 8 && !in_array('__Host-d3x9', $crowded['droppedCookies'], true));

// The payload: revision 1 sends the fixed list, revision 3 everything but what it must not.
$req = [
    'method' => 'POST', 'url' => '/mcp?x=1', 'host' => 'site.example', 'ip' => '203.0.113.7', 'secure' => true, 'timestamp' => 1,
    'entries' => entries_of([
        ['content-type', 'application/json'], ['user-agent', 'agent/1'], ['x-custom', 'c'],
        ['cookie', 'sid=1; __Host-d3pay=' . str_repeat('s', 43)], ['authorization', 'Bearer t'],
        ['content-digest', 'sha-256=:forged=:'],
    ]),
    'body' => '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"a","_meta":{"dna.d3.com/key":"k"}}}',
];
$none = ['headers' => [], 'cookies' => []];
list($p1, $m1) = P::extract($req, ['revision' => 1, 'exclude' => $none]);
check('revision 1 forwards no unlisted header', !isset($p1['headers']['x-custom']) && !isset($p1['cookies']));
check('revision 1 reads no MCP call', $m1 === null && !isset($p1['mcp']));
check('the session cookie rides its own header', $p1['headers']['d3pay-session'] === str_repeat('s', 43));
check('a claimed digest is replaced by the body\'s own', $p1['headers']['content-digest'] === P::contentDigest($req['body']));

list($p3, $m3) = P::extract($req, ['revision' => 3, 'exclude' => ['headers' => ['x-custom'], 'cookies' => []]]);
check('revision 3 keeps an excluded header back', !isset($p3['headers']['x-custom']));
check('revision 3 echoes the exclusion', $p3['excluded']['headers'] === ['x-custom']);
check('revision 3 never forwards authorization', !isset($p3['headers']['authorization']));
check('revision 3 forwards the site\'s cookies, not ours', $p3['cookies']['sid'] === '1' && !isset($p3['cookies']['__Host-d3pay']));
check('revision 3 lifts the call\'s key', $p3['headers']['payment-authorization'] === 'Payment k');
check('revision 3 strips it from the origin\'s body', $m3['origin_body'] !== null && strpos($m3['origin_body'], 'dna.d3.com') === false);
check('revision 3 names the call', $p3['mcp']['method'] === 'tools/call' && $p3['mcp']['tool'] === 'a');

foreach (['GET', 'HEAD'] as $method) {
    list($claimed) = P::extract(['method' => $method, 'url' => '/x', 'host' => 'h', 'ip' => null, 'secure' => true, 'timestamp' => 1,
        'entries' => entries_of([['content-digest', P::contentDigest('')]]), 'body' => 'smuggled'], ['revision' => 3, 'exclude' => $none]);
    check("$method: the digest is the body's, not the empty one claimed", $claimed['headers']['content-digest'] === P::contentDigest('smuggled'));
    list($bare) = P::extract(['method' => $method, 'url' => '/x', 'host' => 'h', 'ip' => null, 'secure' => true, 'timestamp' => 1,
        'entries' => entries_of([]), 'body' => ''], ['revision' => 3, 'exclude' => $none]);
    check("$method: no body and no claim, no digest", !isset($bare['headers']['content-digest']));
}

list($upload) = P::extract(['method' => 'POST', 'url' => '/x', 'host' => 'h', 'ip' => null, 'secure' => true, 'timestamp' => 1,
    'entries' => entries_of([['content-digest', 'sha-256=:forged=:'], ['content-type', 'multipart/form-data; boundary=b']]),
    'body_unavailable' => true], ['revision' => 3, 'exclude' => $none]);
check('a body PHP consumed strips the claimed digest and names it', !isset($upload['headers']['content-digest']) && in_array('content-digest', $upload['droppedHeaders'], true));
list($uploadBare) = P::extract(['method' => 'POST', 'url' => '/x', 'host' => 'h', 'ip' => null, 'secure' => true, 'timestamp' => 1,
    'entries' => entries_of([]), 'body_unavailable' => true], ['revision' => 3, 'exclude' => $none]);
check('with no claim it names nothing', !isset($uploadBare['droppedHeaders']));

list($streamedPayload, $streamedMcp) = P::extract(['method' => 'POST', 'url' => '/x', 'host' => 'h', 'ip' => null, 'secure' => true, 'timestamp' => 1,
    'entries' => entries_of([['content-type', 'application/json']]),
    'streamed' => ['digest' => 'sha-256=:d:', 'names_credential' => true, 'jsonrpc' => true, 'too_large' => true]], ['revision' => 3, 'exclude' => $none]);
check('a streamed body sends its streamed digest', $streamedPayload['headers']['content-digest'] === 'sha-256=:d:');
check('a streamed JSON call past the cap naming a credential is too large', $streamedMcp['unreadable_reason'] === 'too-large');

list($pEx) = P::extract($req, ['revision' => 3, 'exclude' => ['headers' => ['payment-authorization'], 'cookies' => []]]);
check('an excluded payment header is not lifted onto the payload', !isset($pEx['headers']['payment-authorization']));

list($pDbg) = P::extract($req, ['revision' => 3, 'exclude' => $none, 'debug' => true]);
check('debug headers never carry authorization or cookies', isset($pDbg['debugHeaders']) && !isset($pDbg['debugHeaders']['authorization']) && !isset($pDbg['debugHeaders']['cookie']));

// Our own answers.
$blocked = P::blockAnswer((object) ['ruleId' => 'r1', 'verdict' => (object) ['tier' => 'claimed', 'identity' => 'bot']], 'block');
check('a block is a 403 with its rule', $blocked['status'] === 403 && json_decode($blocked['body'])->ruleId === 'r1');
check('a block with nothing known is still a 403', P::blockAnswer(null, 'fail-closed')['body'] === '{"blocked":true}');
$unavailable = P::paymentUnavailableAnswer();
check('payment unavailable is a 502 that is never cached', $unavailable['status'] === 502 && headers_object($unavailable['headers'])['cache-control'] === 'no-store');
$tooLarge = P::unreadableCallAnswer(null);
check('an unreadable call naming a credential is a 413', $tooLarge['status'] === 413 && $tooLarge['mode'] === 'fail-closed');

check('the report goes beside the decision endpoint', P::reportUrl('https://edge-api.d3.com/v1/decision') === 'https://edge-api.d3.com/v1/report');
check('the report keeps the endpoint\'s port', P::reportUrl('http://127.0.0.1:9000/v1/decision') === 'http://127.0.0.1:9000/v1/report');
check('the report path drops the query', P::pathOf('/a/b?x=1') === '/a/b');

// A visitor's padded cookie must cost linear time.
$padded = 'x' . str_repeat(' ', 100000) . 'y=1; ' . str_repeat(' ', 100000) . '=2';
$started = microtime(true);
P::cookiesOf($padded);
P::readCookie($padded, 'z');
P::stripOwnCookies($padded);
P::isJsonType(str_repeat(' ', 100000) . 'x');
P::namesCredential(str_repeat('"', 1000000));
check('cookie and body scans are linear on padded input', microtime(true) - $started < 0.5, sprintf('%.3fs', microtime(true) - $started));

// json_decode refuses what JSON.parse reads: such a call naming our credential is refused, not passed on.
$getJson = function ($name) {
    return $name === 'content-type' ? 'application/json' : null;
};
$lone = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","arguments":{"t":"cut \ud83d here","dna_account_key":"k"}}}';
check('a lone surrogate call naming a credential is unreadable', P::mcpCarriageOf('POST', $getJson, $lone, [])['unreadable_credential'] === true);
$loneFree = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","arguments":{"t":"cut \ud83d here"}}}';
check('one naming none is passed on', P::mcpCarriageOf('POST', $getJson, $loneFree, [])['unreadable_credential'] === false);
$deep = str_repeat('[', 600) . str_repeat(']', 600);
$nested = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","x":' . $deep . ',"_meta":{"dna.d3.com/key":"k"}}}';
check('a call nested past json_decode\'s depth naming a credential is unreadable', P::mcpCarriageOf('POST', $getJson, $nested, [])['unreadable_credential'] === true);
check('a streamed JSON-RPC body naming a credential is not one call',
    P::mcpCarriageOf('POST', $getJson, null, [], ['names_credential' => true, 'jsonrpc' => true, 'too_large' => false])['unreadable_reason'] === 'not-one-call');
check('a streamed body that never says jsonrpc is left alone',
    P::mcpCarriageOf('POST', $getJson, null, [], ['names_credential' => true, 'jsonrpc' => false, 'too_large' => false])['unreadable_credential'] === false);
$notifId = P::readJsonRpcRequest('POST', 'application/json', '{"jsonrpc":"2.0","method":"tools/call","params":{"_meta":{"dna.d3.com/key":"k"}}}');
check('a notification has no id', $notifId['hasId'] === false);
check('the lifted body of a notification keeps it one', strpos(P::liftMcpPayment($notifId)[1], '"id"') === false);
// A number JSON cannot write (PHP reads 1e999 as INF): the stripped call cannot be written back, so it is refused.
$inf = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"arguments":{"q":1e999,"dna_account_key":"K"},"_meta":{"dna.d3.com/key":"M"}}}';
$infCarriage = P::mcpCarriageOf('POST', $getJson, $inf, []);
check('a call that will not encode again is refused, never passed on with its key', $infCarriage['unreadable_credential'] === true
    && $infCarriage['unreadable_reason'] === 'not-one-call' && $infCarriage['origin_body'] === null && $infCarriage['lifted'] === [], $infCarriage);
$infX402 = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"_meta":{"x402/payment":{"v":1e999}}}}';
check('an x402 payment that will not encode is refused too, not lifted empty', P::mcpCarriageOf('POST', $getJson, $infX402, [])['unreadable_credential'] === true);
$infFree = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"arguments":{"q":1e999}}}';
check('one carrying nothing of ours is left alone', P::mcpCarriageOf('POST', $getJson, $infFree, [])['unreadable_credential'] === false);
$nulKey = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"\u0000x":1,"_meta":{"x402\u002fpayment":{"a":1}}}}';
check('a credential behind an escape, in a call PHP reads only as arrays, is refused', P::mcpCarriageOf('POST', $getJson, $nulKey, [])['unreadable_credential'] === true);
$nulFree = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"\u0000x":1}}';
check('one carrying nothing of ours is left alone too', P::mcpCarriageOf('POST', $getJson, $nulFree, [])['unreadable_credential'] === false);
$priced = (object) ['status' => 402, 'bodyKind' => 'json-rpc', 'body' => '{"isError":true}'];
$notified = P::buildPaymentAnswer($priced, 'payment-required', ['hasId' => false, 'id' => null]);
check('a priced notification gets the plain 402: there is no id to answer', $notified['status'] === 402 && strpos((string) $notified['body'], 'jsonrpc') === false, $notified);
$nullId = P::buildPaymentAnswer($priced, 'payment-required', ['hasId' => true, 'id' => null]);
check('a call whose id is null is answered in band with it', $nullId['status'] === 200 && strpos($nullId['body'], '"id":null') !== false, $nullId['body']);
check('a JSON-RPC id that is an object is no call', P::readJsonRpcRequest('POST', 'application/json', '{"jsonrpc":"2.0","id":{},"method":"x"}') === null);

// ── Runtime: what PHP itself hands the site ──────────────────────────────────

$server = [
    'HTTP_USER_AGENT' => 'agent/1', 'HTTP_X_FORWARDED_FOR' => '1.2.3.4', 'CONTENT_TYPE' => 'application/json',
    'CONTENT_LENGTH' => '12', 'HTTP_COOKIE' => 'a=1', 'REQUEST_METHOD' => 'POST', 'HTTP_HOST' => 'h', 'DOCUMENT_ROOT' => '/var/www',
];
same('the request headers PHP has, by their wire names', Runtime::headerEntriesFromServer($server), [
    ['content-length', '12'], ['content-type', 'application/json'], ['cookie', 'a=1'], ['host', 'h'],
    ['user-agent', 'agent/1'], ['x-forwarded-for', '1.2.3.4'],
]);
same('a header PHP also has as HTTP_CONTENT_TYPE is read once', Runtime::headerEntriesFromServer(['CONTENT_TYPE' => 'a', 'HTTP_CONTENT_TYPE' => 'a']), [['content-type', 'a']]);

check('the authority is the Host the agent used', Runtime::requestHost(['HTTP_HOST' => 'www.site.example', 'SERVER_NAME' => 'internal']) === 'www.site.example');
check('HTTPS on is secure', Runtime::isSecure(['HTTPS' => 'on']) && Runtime::isSecure(['HTTPS' => '1']) && !Runtime::isSecure(['HTTPS' => 'off']));
check('port 443 is secure', Runtime::isSecure(['SERVER_PORT' => '443']));
check('a visitor\'s X-Forwarded-Proto is not', !Runtime::isSecure(['HTTP_X_FORWARDED_PROTO' => 'https']));
check('the target is path and query', Runtime::requestTarget(['REQUEST_URI' => '/a?b=1']) === '/a?b=1');
check('an absolute-form target is read by its path', Runtime::requestTarget(['REQUEST_URI' => 'http://h/a?b=1']) === '/a?b=1');
check('a target with no path is /', Runtime::requestTarget([]) === '/');
check('a raw byte in the target goes escaped, as URL parses it', Runtime::requestTarget(['REQUEST_URI' => "/caf\xc3\xa9 x"]) === '/caf%C3%A9%20x');
check('the query is the target\'s, the one the payload names', Runtime::queryOf('/p?a=1&d3pay_handoff=x') === 'a=1&d3pay_handoff=x' && Runtime::queryOf('/p') === '' && Runtime::queryOf('/p?') === '');
check('a REST method override is the method DNA is told', Runtime::restMethod('GET', '/wp-json/mcp', ['_method' => 'post'], []) === 'POST'
    && Runtime::restMethod('GET', '/index.php/wp-json/mcp', [], ['HTTP_X_HTTP_METHOD_OVERRIDE' => 'POST']) === 'POST'
    && Runtime::restMethod('GET', '/?rest_route=/mcp', ['rest_route' => '/mcp', '_method' => 'POST'], []) === 'POST'
    && Runtime::restMethod('POST', '/wp-json/mcp', [], []) === 'POST');
check('outside the REST API an override is nothing WordPress reads', Runtime::restMethod('GET', '/page', ['_method' => 'POST'], []) === 'GET'
    && Runtime::restMethod('GET', '/blog/wp-json-guide', ['_method' => 'POST'], []) === 'GET');
foreach (['/blog/wp-json/mcp', '/site2/wp-json/mcp', '//wp-json/mcp', '/%77p-json/mcp', '/WP-JSON/mcp'] as $path) {
    check("a REST request is one wherever WordPress serves it: $path", Runtime::restMethod('GET', $path, ['_method' => 'POST'], []) === 'POST');
}

putenv('DNA_HOSTS=www.site.example, Site.example');
same('the site\'s hosts are DNA_HOSTS, lowercased', Runtime::siteHosts(), ['www.site.example', 'site.example']);
putenv('DNA_HOSTS');
define('WP_HOME', 'http://whatever-the-visitor-sent.example');
same('WP_HOME pins nothing: sites often build it from the Host header', Runtime::siteHosts(), []);

check('a URL\'s host as a Host header names it', Runtime::hostOf('https://WWW.Site.example/blog') === 'www.site.example'
    && Runtime::hostOf('http://127.0.0.1:8130') === '127.0.0.1:8130' && Runtime::hostOf('not a url') === null && Runtime::hostOf(false) === null);
check('a host the site lists is decided as itself, in any case', Runtime::decidedHost('WWW.site.example', ['site.example', 'www.site.example']) === 'WWW.site.example');
check('a host the site does not list is decided as its first: a visitor cannot pick one with no rules',
    Runtime::decidedHost('evil.example', ['site.example', 'www.site.example']) === 'site.example');
check('with no host known, the Host header is all there is', Runtime::decidedHost('evil.example', []) === 'evil.example');
$hash = str_repeat('a', 32);
same('WordPress login cookies are kept back by default, by the names the request carries', Runtime::withWordPressSessionCookies(['sid'],
    "wordpress_logged_in_$hash=u; wordpress_sec_$hash=s; wordpress_$hash=a; wp-postpass_$hash=p; wordpress_test_cookie=t; wp-settings-1=x; sid=1"
), ['sid', "wordpress_logged_in_$hash", "wordpress_sec_$hash", "wordpress_$hash", "wp-postpass_$hash"]);
same('a WooCommerce session is kept back too', Runtime::withWordPressSessionCookies([], "wp_woocommerce_session_$hash=s"), ["wp_woocommerce_session_$hash"]);
same('a cookie only shaped like one is not', Runtime::withWordPressSessionCookies([], "wordpress_logged_in_{$hash}x=u; xwordpress_$hash=v"), []);

$id = Runtime::requestId();
check('a request id is a v4 UUID', preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $id) === 1, $id);

// The origin's copy of the request, which WordPress reads.
$_SERVER = [
    'REQUEST_URI' => '/p?t=1&d3pay_handoff=h&keep=1&d3pay_browser=1', 'QUERY_STRING' => 't=1&d3pay_handoff=h&keep=1&d3pay_browser=1',
    'HTTP_COOKIE' => 'sid=1; __Host-d3pay=s; theme=dark; __Secure-d3visitor=v; __Host-d3person =p',
    'HTTP_PAYMENT_SIGNATURE' => 'x', 'HTTP_X_PAYMENT' => 'x', 'HTTP_PAYMENT_AUTHORIZATION' => 'x', 'HTTP_D3PAY_SESSION' => 'x',
    'HTTP_D3PAY_PERSON' => 'x', 'HTTP_MCP_PARAM_DNA_KEY' => 'x', 'HTTP_X_D3_TIER' => 'proven', 'HTTP_X_D3_IDENTITY' => 'forged',
    'HTTP_AUTHORIZATION' => 'Bearer site',
];
$_GET = ['t' => '1', 'd3pay_handoff' => 'h', 'keep' => '1', 'd3pay_browser' => '1'];
$_COOKIE = ['sid' => '1', '__Host-d3pay' => 's', 'theme' => 'dark', '__Secure-d3visitor' => 'v', '__Host-d3person_' => 'p'];
$_REQUEST = ['t' => '1', 'd3pay_handoff' => 'h', 'keep' => '1', 'd3pay_browser' => '1', '__Host-d3pay' => 's'];
Runtime::stripForOrigin();
check('strip: no payment header, mirrored key or visitor verdict', !array_intersect_key($_SERVER, array_flip([
    'HTTP_PAYMENT_SIGNATURE', 'HTTP_X_PAYMENT', 'HTTP_PAYMENT_AUTHORIZATION', 'HTTP_D3PAY_SESSION', 'HTTP_D3PAY_PERSON',
    'HTTP_MCP_PARAM_DNA_KEY', 'HTTP_X_D3_TIER', 'HTTP_X_D3_IDENTITY',
])), $_SERVER);
check('strip: the site\'s own bearer stays', $_SERVER['HTTP_AUTHORIZATION'] === 'Bearer site');
check('strip: no cookie of ours in the header', $_SERVER['HTTP_COOKIE'] === 'sid=1; theme=dark', $_SERVER['HTTP_COOKIE']);
check('strip: nor in $_COOKIE, whatever PHP made of the name', array_keys($_COOKIE) === ['sid', 'theme'], $_COOKIE);
check('strip: our params gone from the URI, the rest in order', $_SERVER['REQUEST_URI'] === '/p?t=1&keep=1' && $_SERVER['QUERY_STRING'] === 't=1&keep=1', $_SERVER);
check('strip: and from $_GET and $_REQUEST', array_keys($_GET) === ['t', 'keep'] && array_keys($_REQUEST) === ['t', 'keep'], [$_GET, $_REQUEST]);

$_SERVER = [
    'REQUEST_URI' => '/p?a+b&d3pay_handoff=h', 'QUERY_STRING' => 'a+b&d3pay_handoff=h', 'REDIRECT_QUERY_STRING' => 'a+b&d3pay_handoff=h',
    'UNENCODED_URL' => '/p?d3pay_handoff=h', 'argv' => ['a', 'b&d3pay_handoff=h'], 'argc' => 2,
];
$_ENV = ['HTTP_COOKIE' => '__Host-d3pay=s; a=1', 'HTTP_X_PAYMENT' => 'p', 'HTTP_X_D3_TIER' => 'proven', 'QUERY_STRING' => 'd3pay_handoff=h', 'PATH' => '/bin'];
$_GET = [];
$_COOKIE = [];
Runtime::stripForOrigin();
check('strip: every copy of the URL PHP keeps', $_SERVER['REDIRECT_QUERY_STRING'] === 'a+b' && $_SERVER['UNENCODED_URL'] === '/p', $_SERVER);
check('strip: argv is the stripped query', $_SERVER['argv'] === ['a', 'b'] && $_SERVER['argc'] === 2, $_SERVER['argv']);
check('strip: and $_ENV, when PHP put the request there too', $_ENV === ['HTTP_COOKIE' => 'a=1', 'QUERY_STRING' => '', 'PATH' => '/bin'], $_ENV);
$_ENV = [];

$_SERVER = ['REQUEST_URI' => '/p?d3pay_handoff=h', 'QUERY_STRING' => 'd3pay_handoff=h', 'HTTP_COOKIE' => '__Host-d3pay=s'];
$_GET = ['d3pay_handoff' => 'h'];
$_COOKIE = ['__Host-d3pay' => 's'];
$_REQUEST = [];
Runtime::stripForOrigin();
check('strip: a URI left with no query loses its ?', $_SERVER['REQUEST_URI'] === '/p' && $_SERVER['QUERY_STRING'] === '');
check('strip: a jar of only ours is no Cookie header', !isset($_SERVER['HTTP_COOKIE']) && $_COOKIE === []);

$_SERVER = ['REQUEST_URI' => '/p?d3pay.handoff=h&x=1', 'QUERY_STRING' => 'd3pay.handoff=h&x=1'];
$_GET = ['d3pay_handoff' => 'h', 'x' => '1'];
$_REQUEST = $_GET;
Runtime::stripForOrigin();
check('strip: a param PHP names into our space never reaches $_GET', !isset($_GET['d3pay_handoff']) && $_GET['x'] === '1', $_GET);

$_SERVER = ['REQUEST_URI' => '/p?a=1', 'QUERY_STRING' => 'a=1', 'HTTP_COOKIE' => 'sid=1'];
$_GET = ['a' => '1'];
$_COOKIE = ['sid' => '1'];
$before = [$_SERVER, $_GET, $_COOKIE];
Runtime::stripForOrigin();
check('strip: a request with nothing of ours is left exactly as PHP read it', [$_SERVER, $_GET, $_COOKIE] === $before);

// Flags shared across requests, here through the temp directory: the CLI has no APCu.
$key = 'unit ' . uniqid();
check('memory: a claim holds the key for its seconds', D3\Dna\Memory::claim($key, 60) && !D3\Dna\Memory::claim($key, 60));
D3\Dna\Memory::hold("$key held", 60);
check('memory: a held flag is there, and gone once dropped', D3\Dna\Memory::holds("$key held", 60) && (D3\Dna\Memory::drop("$key held") || true) && !D3\Dna\Memory::holds("$key held", 60));
check('memory: a flag older than asked is not held', !D3\Dna\Memory::holds($key, -1));
$counted = array_map(function () use ($key) {
    return D3\Dna\Memory::count("$key count", 60);
}, range(1, 3));
check('memory: a count goes up within its window', $counted === [1, 2, 3], $counted);
check('memory: and starts again once the window has passed', D3\Dna\Memory::count("$key count", -1) === 1);

// php:// with the stripped call in php://input, and every other php:// stream PHP's own.
D3\Dna\InputStream::install('{"stripped":true}');
check('input stream: php://input reads the stripped call', file_get_contents('php://input') === '{"stripped":true}');
$temp = fopen('php://temp', 'w+');
fwrite($temp, 'kept');
rewind($temp);
check('input stream: php://temp is PHP\'s own', stream_get_contents($temp) === 'kept');
$read = [$temp];
$none = null;
check('input stream: stream_select reaches PHP\'s stream', @stream_select($read, $none, $none, 0) !== false);
check('input stream: php://input is never included', (@include 'php://input') === false);
check('input stream: a filter over the original body is refused', @file_get_contents('php://filter/read=string.rot13/resource=php://input') === false);
stream_wrapper_restore('php');

// The response headers PHP holds, merged with DNA's.
same('payment headers: Set-Cookie and the CORS list appended, the rest replace, caching narrowed', Runtime::decoratedHeaders(
    ['Content-Type: text/html', 'Set-Cookie: site=1', 'Access-Control-Expose-Headers: X-WP-Total', 'Cache-Control: public, max-age=60', 'Payment-Receipt: theirs'],
    ['payment-receipt' => 'ours', 'set-cookie' => '__Host-d3pay=N; Path=/', 'access-control-expose-headers' => 'payment-receipt'],
    true
), [
    'replace' => ['payment-receipt' => 'ours', 'cache-control' => 'private, max-age=60'],
    'append' => [['set-cookie', '__Host-d3pay=N; Path=/'], ['access-control-expose-headers', 'payment-receipt']],
]);
same('payment headers: an origin with no caching is made private', Runtime::decoratedHeaders([], ['payment-receipt' => 'r'], true)['replace'], ['payment-receipt' => 'r', 'cache-control' => 'private']);
same('no payment headers, no change to the origin\'s caching', Runtime::decoratedHeaders(['Cache-Control: public'], [], false), ['replace' => [], 'append' => []]);
same('the answer\'s no-store replaces the origin\'s caching', Runtime::decoratedHeaders(['Cache-Control: public'], ['cache-control' => 'no-store'], true)['replace'], ['cache-control' => 'no-store']);

check('the origin\'s own header read back by name', Runtime::responseHeader(['Content-Type: application/json', 'content-type: x'], 'content-type') === 'application/json, x');

// The plugin header names the version this build sends.
$plugin = file_get_contents(__DIR__ . '/../d3-dna/d3-dna.php');
preg_match('/^\s*\*\s*Version:\s*(\S+)/m', $plugin, $m);
check('the plugin header names the version dna-adapter sends', 'wordpress:' . ($m[1] ?? '?') === Runtime::DNA_ADAPTER, $m[1] ?? null);

echo sprintf("%d passed, %d failed\n", $passed, $failed);
exit($failed === 0 ? 0 : 1);
