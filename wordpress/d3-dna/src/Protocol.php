<?php
// The DNA wire contract for PHP, ported from @d3-inc/d3-dna-protocol. Pure
// functions only: Runtime.php does the request I/O. test/unit.php checks each
// against the package's own answers (openresty/test/parity.json), so the TS
// function named above each one is the spec.
//
// JSON objects are stdClass and JSON arrays are lists throughout, as
// json_decode($s, false) reads them: an assoc array cannot tell `{}` from `[]`.

namespace D3\Dna;

final class Protocol
{
    const ADAPTER_SET = 3;
    const FORWARDED_HEADER_SET = 2;
    const FORWARDS_ALL_SINCE = 2;
    const CARRIES_MCP_SINCE = 3;

    const FORWARDED_MAX_COOKIES = 256;
    const FORWARDED_MAX_NAMES = 128;
    const FORWARDED_VALUE_MAX_LENGTH = 2048;
    const FORWARDED_MAX_TOTAL_LENGTH = 16384;
    const MAX_DEBUG_HEADERS = 64;
    const MAX_DEBUG_HEADER_LENGTH = 2048;
    const MCP_BODY_MAX_BYTES = 1048576;
    const MCP_RESULT_MAX_BYTES = 4194304;
    const MCP_METHOD_MAX_LENGTH = 128;
    const MCP_NAME_MAX_LENGTH = 256;

    const DEFAULT_ENDPOINT = 'https://edge-api.d3.com/v1/decision';
    // Not the SDKs' 2 s: PHP opens a fresh TLS connection per request, and every page waits on it.
    const DEFAULT_TIMEOUT_MS = 1000;
    const DEFAULT_PAYMENT_TIMEOUT_MS = 10000;

    const PAY_SESSION_COOKIE = '__Host-d3pay';
    const PAY_SESSION_HEADER = 'd3pay-session';
    const PERSON_PASS_COOKIE = '__Host-d3person';
    const PERSON_PASS_HEADER = 'd3pay-person';
    const COOKIE_TOKEN_MAX = 64;
    const VISITOR_ID_ZONE_COOKIE = '__Secure-d3visitor';
    const VISITOR_ID_HOST_COOKIE = '__Host-d3visitor';
    const PAY_HANDOFF_PARAM = 'd3pay_handoff';
    const MCP_DNA_KEY_HEADER = 'mcp-param-dna-key';
    const MCP_KEY_ARGUMENT = 'dna_account_key';
    const MCP_X402_META = 'x402/payment';
    const MCP_DNA_KEY_META = 'dna.d3.com/key';

    const NAMESPACE_MAX_COOKIES = 8;
    const NAMESPACE_MAX_TOTAL_LENGTH = 4096;
    const NAMESPACE_NAME_MAX_LENGTH = 256;

    const JSON_TYPE = 'application/json; charset=utf-8';

    const FORWARDED_HEADERS = [
        'signature', 'signature-input', 'signature-agent', 'user-agent', 'content-digest', 'accept',
        'sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests',
        'sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile', 'accept-language',
        'sec-purpose', 'x-purpose', 'purpose',
        'x-scitt-receipt', 'x-ans-status-token', 'dpop',
        'payment-signature', 'x-payment', 'payment-authorization',
    ];

    const HEADER_LENGTH_CAPS = [
        'x-scitt-receipt' => 1398104, 'x-ans-status-token' => 1398104, 'dpop' => 8192,
        'accept' => 256,
        'sec-fetch-mode' => 32, 'sec-fetch-dest' => 32, 'upgrade-insecure-requests' => 32,
        'sec-ch-ua' => 256, 'sec-ch-ua-platform' => 256, 'sec-ch-ua-mobile' => 256, 'accept-language' => 256,
        'payment-signature' => 4096, 'x-payment' => 4096, 'payment-authorization' => 4096,
        'd3pay-session' => 64,
    ];

    const NEVER_FORWARDED_HEADERS = [
        'connection', 'transfer-encoding', 'content-length', 'host', 'authorization', 'proxy-authorization',
        'cookie', 'mcp-param-dna-key', 'x-vercel-oidc-token',
        'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret',
    ];

    // Presenting one of these under its cap is a payment, and buys the payment budget.
    const PAYMENT_HEADER_CAPS = [
        'payment-signature' => 4096, 'x-payment' => 4096, 'payment-authorization' => 4096,
        'd3pay-session' => 64,
    ];

    // payment-header.ts ORIGIN_STRIPPED_HEADERS: never to the origin.
    const ORIGIN_STRIPPED_HEADERS = [
        'payment-signature', 'x-payment', 'payment-authorization', 'd3pay-session', 'd3pay-person',
        'mcp-param-dna-key',
    ];

    // Only DNA's verdict may reach the site under these names, never a visitor's.
    const VERDICT_HEADERS = ['x-d3-tier', 'x-d3-identity'];

    // Appended to the origin's own; every other payment header replaces the origin's.
    const MERGED_HEADERS = ['access-control-expose-headers', 'set-cookie'];

    const SETTING_NAMES = [
        'api_key' => ['DNA_API_KEY', 'POLICY_ADAPTER_KEY', 'POLICY_SHARED_SECRET'],
        'endpoint' => ['DNA_ENDPOINT', 'POLICY_WORKER_URL'],
        'enabled' => ['DNA_ENABLED'],
        'fail_mode' => ['DNA_FAIL_MODE', 'FAIL_MODE'],
        'timeout_ms' => ['DNA_TIMEOUT_MS', 'POLICY_TIMEOUT_MS'],
        'payment_timeout_ms' => ['DNA_PAYMENT_TIMEOUT_MS', 'POLICY_PAYMENT_TIMEOUT_MS'],
        'debug' => ['DNA_DEBUG_LOG_RAW_PAYLOAD', 'DEBUG_LOG_RAW_PAYLOAD'],
        'exclude_headers' => ['DNA_EXCLUDE_HEADERS'],
        'exclude_cookies' => ['DNA_EXCLUDE_COOKIES'],
    ];

    public static function mcpKeyArgumentSchema()
    {
        return (object) [
            'type' => 'string',
            'description' => 'A DNA account key that pays for this call. Leave it out to be told how to pay.',
            'x-mcp-header' => 'Dna-Key',
        ];
    }

    // ── Small helpers ────────────────────────────────────────────────────────

    public static function startsWith($s, $prefix)
    {
        return strncmp($s, $prefix, strlen($prefix)) === 0;
    }

    public static function isRecord($v)
    {
        return $v instanceof \stdClass;
    }

    private static function stringOrNull($v)
    {
        return is_string($v) && $v !== '' ? $v : null;
    }

    // String.prototype.trim's whitespace in the ASCII range, which is all a header carries.
    public static function trim($s)
    {
        return trim($s, " \t\n\r\x0B\x0C");
    }

    private static function prop($record, $name)
    {
        return self::isRecord($record) && property_exists($record, $name) ? $record->{$name} : null;
    }

    private static function has($record, $name)
    {
        return self::isRecord($record) && property_exists($record, $name);
    }

    // ── JSON ─────────────────────────────────────────────────────────────────

    /** JSON as JSON.stringify writes it; a host's serialize_precision of 17 would write 0.1 as 0.10000000000000001. */
    public static function jsonEncode($value)
    {
        $previous = ini_get('serialize_precision');
        ini_set('serialize_precision', '-1');
        try {
            $out = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        } finally {
            ini_set('serialize_precision', $previous);
        }

        return $out === false ? null : $out;
    }

    /** Objects as stdClass; null for anything that does not parse. A UTF-8 BOM is dropped, as TextDecoder drops it. */
    public static function jsonDecode($s)
    {
        if (!is_string($s)) return null;

        if (strncmp($s, "\xEF\xBB\xBF", 3) === 0) $s = substr($s, 3);
        $parsed = json_decode($s, false, 512);
        return json_last_error() === JSON_ERROR_NONE ? $parsed : null;
    }

    // ── Settings (adapter-settings.ts) ───────────────────────────────────────

    /** parseExclusionList: names, trimmed, blanks and repeats dropped, never capped. */
    public static function parseExclusionList($raw, $lowercase)
    {
        $names = [];
        $seen = [];
        foreach (explode(',', (string) $raw) as $part) {
            $name = self::trim($part);
            if ($lowercase) $name = strtolower($name);
            if ($name !== '' && !isset($seen[$name])) {
                $seen[$name] = true;
                $names[] = $name;
            }
        }

        return $names;
    }

    /** dnaEndpoint: DNA_ENABLED=false, an empty endpoint, or no DNA_API_KEY is off. */
    public static function dnaEndpoint($endpoint, $hasDnaApiKey, $enabled)
    {
        if ($enabled !== null && strtolower(self::trim($enabled)) === 'false') return null;

        if ($endpoint !== null) return $endpoint === '' ? null : $endpoint;

        return $hasDnaApiKey ? self::DEFAULT_ENDPOINT : null;
    }

    private static function firstSetting(callable $lookup, array $names, $countsEmpty)
    {
        foreach ($names as $name) {
            $value = $lookup($name);
            if ($value !== null && ($countsEmpty || $value !== '')) return [$name, $value];
        }

        return [null, null];
    }

    private static function positiveNumber($raw, $fallback)
    {
        if ($raw === null || !is_numeric(self::trim($raw))) return $fallback;

        $n = (float) $raw;
        return $n > 0 && is_finite($n) ? $n : $fallback;
    }

    /** readAdapterSettings, but the unpaid budget defaults to DEFAULT_TIMEOUT_MS. `$lookup(name)` is a string or null. */
    public static function settings(callable $lookup)
    {
        $names = self::SETTING_NAMES;
        $read = function (array $list) use ($lookup) {
            return self::firstSetting($lookup, $list, false)[1];
        };
        $endpoint = self::firstSetting($lookup, $names['endpoint'], true)[1];
        list($keyName, $apiKey) = self::firstSetting($lookup, $names['api_key'], false);
        // A host's own DEBUG_LOG_RAW_PAYLOAD would forward every header to us, so that
        // generic name counts only on an install still using POLICY_WORKER_URL.
        $debugNames = $lookup('POLICY_WORKER_URL') !== null ? $names['debug'] : ['DNA_DEBUG_LOG_RAW_PAYLOAD'];

        return [
            'endpoint' => self::dnaEndpoint($endpoint, $keyName === 'DNA_API_KEY', $read($names['enabled'])),
            'api_key' => $apiKey,
            'fail_mode' => $read($names['fail_mode']) === 'closed' ? 'closed' : 'open',
            'timeout_ms' => self::positiveNumber($read($names['timeout_ms']), self::DEFAULT_TIMEOUT_MS),
            'payment_timeout_ms' => self::positiveNumber(
                $read($names['payment_timeout_ms']),
                self::DEFAULT_PAYMENT_TIMEOUT_MS
            ),
            'debug_log_raw_payload' => $read($debugNames) === 'true',
            'exclude' => [
                'headers' => self::parseExclusionList($read($names['exclude_headers']), true),
                'cookies' => self::parseExclusionList($read($names['exclude_cookies']), false),
            ],
        ];
    }

    /** exclusionOverflowWarning: what to tell a site whose list is longer than DNA is sent. */
    public static function exclusionOverflowWarning(array $exclude)
    {
        $lines = [];
        foreach (['headers' => 'header', 'cookies' => 'cookie'] as $kind => $one) {
            $n = count($exclude[$kind]);
            if ($n > self::FORWARDED_MAX_NAMES) {
                $lines[] = sprintf(
                    'DNA_EXCLUDE_%s lists %d names, past the %d DNA is sent: it reads any %s a request lacks as kept back, and skips the rules that check one',
                    strtoupper($kind),
                    $n,
                    self::FORWARDED_MAX_NAMES,
                    $one
                );
            }
        }

        return $lines === [] ? null : implode('; ', $lines);
    }

    // ── Cookies and our URL params (pay-session.ts, namespace.ts) ────────────

    /** Ours on a site. The lowercase letter keeps out our own apps' `__Host-d3_*` and `__Secure-d3-*`. */
    public static function isNamespaceCookie($name)
    {
        if (!is_string($name)) return false;

        if (self::startsWith($name, '__Host-d3')) {
            $next = substr($name, 9, 1);
        } elseif (self::startsWith($name, '__Secure-d3')) {
            $next = substr($name, 11, 1);
        } else {
            return false;
        }

        return $next !== false && $next >= 'a' && $next <= 'z' && strlen($next) === 1;
    }

    public static function isNamespaceParam($name)
    {
        return is_string($name) && self::startsWith($name, 'd3pay_');
    }

    private static function isReservedCookie($name)
    {
        return in_array(
            $name,
            [self::PAY_SESSION_COOKIE, self::PERSON_PASS_COOKIE, self::VISITOR_ID_ZONE_COOKIE, self::VISITOR_ID_HOST_COOKIE],
            true
        );
    }

    private static function cookieName($pair)
    {
        $eq = strpos($pair, '=');
        return self::trim($eq === false ? $pair : substr($pair, 0, $eq));
    }

    /** cookiesOf: every cookie as [name, value], in order. */
    public static function cookiesOf($header)
    {
        $out = [];
        if ($header === null || $header === '') return $out;

        foreach (explode(';', $header) as $pair) {
            $eq = strpos($pair, '=');
            if ($eq === false) continue;

            $name = self::cookieName($pair);
            if ($name !== '') $out[] = [$name, self::trim(substr($pair, $eq + 1))];
        }

        return $out;
    }

    public static function readCookie($header, $name)
    {
        if ($header === null || $header === '') return null;

        foreach (explode(';', $header) as $pair) {
            $eq = strpos($pair, '=');
            if ($eq !== false && self::cookieName($pair) === $name) return self::trim(substr($pair, $eq + 1));
        }

        return null;
    }

    /** stripOwnCookies: by name as read, never a prefix, so `__Host-d3person =x` goes too. Null when nothing is left. */
    public static function stripOwnCookies($header)
    {
        $kept = [];
        foreach (explode(';', $header) as $pair) {
            $trimmed = self::trim($pair);
            if ($trimmed !== '' && !self::isNamespaceCookie(self::cookieName($trimmed))) $kept[] = $trimmed;
        }

        return $kept === [] ? null : implode('; ', $kept);
    }

    public static function holdsOwnCookie($header)
    {
        foreach (explode(';', (string) $header) as $pair) {
            if (self::isNamespaceCookie(self::cookieName(self::trim($pair)))) return true;
        }

        return false;
    }

    // URLSearchParams' decoding: `+` is a space, then percent escapes.
    private static function unescape($s)
    {
        return rawurldecode(str_replace('+', ' ', $s));
    }

    /** splitHandoffToken: a 22-char id, a dot, a 43-char signature, base64url both. */
    private static function isHandoffToken($token)
    {
        return preg_match('/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/D', $token) === 1;
    }

    /** handoffFromUrl, from the query string: the first d3pay_handoff, if well formed. */
    public static function handoffFromQuery($query)
    {
        if ($query === null || $query === '') return null;

        foreach (explode('&', $query) as $pair) {
            $eq = strpos($pair, '=');
            $name = $eq === false ? $pair : substr($pair, 0, $eq);
            if (self::unescape($name) === self::PAY_HANDOFF_PARAM) {
                $value = self::unescape($eq === false ? '' : substr($pair, $eq + 1));
                return self::isHandoffToken($value) ? $value : null;
            }
        }

        return null;
    }

    /** stripPayParams: the URL without our params; the rest keep their order and escapes. */
    public static function stripPayParams($url)
    {
        $query = strpos($url, '?');
        if ($query === false) return $url;

        $kept = [];
        foreach (explode('&', substr($url, $query + 1)) as $pair) {
            if (!self::isNamespaceParam(self::unescape(explode('=', $pair, 2)[0]))) $kept[] = $pair;
        }

        return $kept === [] ? substr($url, 0, $query) : substr($url, 0, $query + 1) . implode('&', $kept);
    }

    // ── Forwarding (forward-all.ts, extract.ts) ──────────────────────────────

    /** Header pairs as fetch's Headers iterates them: lowercase, sorted, repeats joined. */
    public static function headerEntries(array $raw)
    {
        $byName = [];
        foreach ($raw as $name => $value) {
            $lower = strtolower((string) $name);
            if (is_array($value)) $value = implode($lower === 'cookie' ? '; ' : ', ', $value);
            $byName[$lower] = isset($byName[$lower])
                ? $byName[$lower] . ($lower === 'cookie' ? '; ' : ', ') . $value
                : (string) $value;
        }
        ksort($byName, SORT_STRING);

        $out = [];
        foreach ($byName as $name => $value) $out[] = [(string) $name, $value];
        return $out;
    }

    public static function lookup(array $entries)
    {
        $byName = [];
        foreach ($entries as $entry) $byName[$entry[0]] = $entry[1];
        return $byName;
    }

    private static function drop(array &$out, array $candidate)
    {
        if ($candidate['kind'] === 'header') {
            $out['droppedHeaders'][] = $candidate['name'];
        } else {
            $out['droppedCookies'][] = $candidate['name'];
        }
    }

    /** withinTotal: each over-long value goes, then the longest until the rest fit, ties in arrival order. */
    private static function withinTotal(array $pooled, array &$out)
    {
        $fitting = [];
        foreach ($pooled as $candidate) {
            if (strlen($candidate['value']) > self::FORWARDED_VALUE_MAX_LENGTH) {
                self::drop($out, $candidate);
            } else {
                $fitting[] = $candidate;
            }
        }

        $size = function ($c) {
            return strlen($c['name']) + strlen($c['value']);
        };
        $total = 0;
        foreach ($fitting as $c) $total += $size($c);
        if ($total <= self::FORWARDED_MAX_TOTAL_LENGTH) return $fitting;

        $order = array_keys($fitting);
        // usort is not stable before PHP 8, so the index breaks ties.
        usort($order, function ($a, $b) use ($fitting, $size) {
            $sa = $size($fitting[$a]);
            $sb = $size($fitting[$b]);
            return $sa !== $sb ? $sb - $sa : $a - $b;
        });

        $dropped = [];
        foreach ($order as $i) {
            if ($total <= self::FORWARDED_MAX_TOTAL_LENGTH) break;

            $dropped[$i] = true;
            $total -= $size($fitting[$i]);
            self::drop($out, $fitting[$i]);
        }

        $kept = [];
        foreach ($fitting as $i => $c) {
            if (!isset($dropped[$i])) $kept[] = $c;
        }

        return $kept;
    }

    private static function withListedDrops(array $out)
    {
        $out['droppedUnlisted'] = [
            'headers' => count($out['droppedHeaders']) > self::FORWARDED_MAX_NAMES,
            'cookies' => count($out['droppedCookies']) > self::FORWARDED_MAX_NAMES,
        ];
        $out['droppedHeaders'] = array_slice($out['droppedHeaders'], 0, self::FORWARDED_MAX_NAMES);
        $out['droppedCookies'] = array_slice($out['droppedCookies'], 0, self::FORWARDED_MAX_NAMES);
        return $out;
    }

    /**
     * keepOurs: ours ride outside the shared caps. The prefix is a label no browser
     * enforces, so the ones we set keep their place and the rest share a budget,
     * dropped unnamed past it: naming them would overflow droppedCookies.
     */
    private static function keepOurs(array &$out, $name, $value, array &$budget)
    {
        if (self::isReservedCookie($name)) {
            if (strlen($value) > self::FORWARDED_VALUE_MAX_LENGTH) {
                $out['droppedCookies'][] = $name;
            } else {
                $out['cookies'][$name] = $value;
            }
            return;
        }

        if (strlen($name) > self::NAMESPACE_NAME_MAX_LENGTH || $budget['count'] >= self::NAMESPACE_MAX_COOKIES) return;

        $size = strlen($name) + strlen($value);
        if ($budget['length'] + $size > self::NAMESPACE_MAX_TOTAL_LENGTH) return;

        $budget['count']++;
        $budget['length'] += $size;
        $out['cookies'][$name] = $value;
    }

    /**
     * forwardAll: every header and cookie but the never-sent, the excluded and our two
     * cookies. `headers` and `cookies` come back as name => value arrays.
     */
    public static function forwardAll(array $entries, array $exclude, array $caps)
    {
        $excludedHeaders = array_flip($exclude['headers']);
        $excludedCookies = array_flip($exclude['cookies']);
        $never = array_flip(self::NEVER_FORWARDED_HEADERS);
        $out = ['headers' => [], 'cookies' => [], 'droppedHeaders' => [], 'droppedCookies' => []];
        $pooled = [];

        foreach ($entries as $entry) {
            list($name, $value) = $entry;
            if (isset($never[$name]) || isset($excludedHeaders[$name])) continue;

            if (isset($caps[$name])) {
                if (strlen($value) > $caps[$name]) {
                    $out['droppedHeaders'][] = $name;
                } else {
                    $out['headers'][$name] = $value;
                }
            } else {
                $pooled[] = ['kind' => 'header', 'name' => $name, 'value' => $value];
            }
        }

        // The first of a repeated name, as readCookie and most servers read it.
        $seen = [];
        $theirs = 0;
        $budget = ['count' => 0, 'length' => 0];
        $cookieHeader = self::lookup($entries)['cookie'] ?? null;
        foreach (self::cookiesOf($cookieHeader) as $cookie) {
            list($name, $value) = $cookie;
            if ($name === self::PAY_SESSION_COOKIE || $name === self::PERSON_PASS_COOKIE) continue;
            if (isset($excludedCookies[$name]) || isset($seen[$name])) continue;

            $seen[$name] = true;
            if (self::isNamespaceCookie($name)) {
                self::keepOurs($out, $name, $value, $budget);
            } elseif (++$theirs > self::FORWARDED_MAX_COOKIES) {
                $out['droppedCookies'][] = $name;
            } else {
                $pooled[] = ['kind' => 'cookie', 'name' => $name, 'value' => $value];
            }
        }

        foreach (self::withinTotal($pooled, $out) as $c) {
            if ($c['kind'] === 'header') {
                $out['headers'][$c['name']] = $c['value'];
            } else {
                $out['cookies'][$c['name']] = $c['value'];
            }
        }

        return self::withListedDrops($out);
    }

    /** Below revision 2: the fixed list, each header under its cap. */
    private static function allowlisted(array $byName)
    {
        $headers = [];
        $dropped = [];
        foreach (self::FORWARDED_HEADERS as $name) {
            if (!isset($byName[$name])) continue;

            $cap = self::HEADER_LENGTH_CAPS[$name] ?? null;
            if ($cap !== null && strlen($byName[$name]) > $cap) {
                $dropped[] = $name;
            } else {
                $headers[$name] = $byName[$name];
            }
        }

        return [
            'headers' => $headers,
            'cookies' => [],
            'droppedHeaders' => $dropped,
            'droppedCookies' => [],
            'droppedUnlisted' => ['headers' => false, 'cookies' => false],
        ];
    }

    /** withheldOf: the exclusions echoed, and each kind past its lists flagged. */
    public static function withheldOf(array $exclude, array $droppedUnlisted)
    {
        $unlisted = [
            'headers' => $droppedUnlisted['headers'] || count($exclude['headers']) > self::FORWARDED_MAX_NAMES,
            'cookies' => $droppedUnlisted['cookies'] || count($exclude['cookies']) > self::FORWARDED_MAX_NAMES,
        ];
        $out = [];
        if ($unlisted['headers'] || $unlisted['cookies']) $out['droppedUnlisted'] = $unlisted;
        if ($exclude['headers'] !== [] || $exclude['cookies'] !== []) {
            $out['excluded'] = [
                'headers' => array_slice($exclude['headers'], 0, self::FORWARDED_MAX_NAMES),
                'cookies' => array_slice($exclude['cookies'], 0, self::FORWARDED_MAX_NAMES),
            ];
        }

        return $out;
    }

    /** debugHeadersOf: for the request record alone, under DNA_DEBUG_LOG_RAW_PAYLOAD. */
    public static function debugHeadersOf(array $entries, array $excluded)
    {
        $keptBack = array_flip($excluded);
        $never = array_flip(self::NEVER_FORWARDED_HEADERS);
        $out = [];
        foreach ($entries as $entry) {
            if (count($out) === self::MAX_DEBUG_HEADERS) break;

            list($name, $value) = $entry;
            if (!isset($never[$name]) && !isset($keptBack[$name]) && strlen($value) <= self::MAX_DEBUG_HEADER_LENGTH) {
                $out[$name] = $value;
            }
        }

        return $out;
    }

    // ── Payment presence (payment-header.ts) ─────────────────────────────────

    /** hasPaymentHeader over the visitor's headers: presence under the cap, never a decode. */
    public static function hasPaymentHeader(array $byName)
    {
        foreach (self::PAYMENT_HEADER_CAPS as $name => $cap) {
            $value = $byName[$name] ?? null;
            if ($value !== null && $value !== '' && strlen($value) <= $cap) return true;
        }

        $session = self::readCookie($byName['cookie'] ?? null, self::PAY_SESSION_COOKIE);
        return $session !== null && $session !== '' && strlen($session) <= self::COOKIE_TOKEN_MAX;
    }

    /** edgeRequestPresentsPayment: on the request, or lifted from an MCP call onto the payload. */
    public static function presentsPayment(array $byName, $query, array $payloadHeaders)
    {
        return self::hasPaymentHeader($byName)
            || self::handoffFromQuery($query) !== null
            || self::hasPaymentHeader($payloadHeaders);
    }

    // ── MCP (mcp.ts) ─────────────────────────────────────────────────────────

    public static function isJsonType($contentType)
    {
        $semi = strpos((string) $contentType, ';');
        $kind = strtolower(self::trim($semi === false ? (string) $contentType : substr($contentType, 0, $semi)));
        return $kind === 'application/json' || substr($kind, -5) === '+json';
    }

    /** readJsonRpcRequest: one call in a JSON POST body, else null. `hasId` is false when the call has none. */
    public static function readJsonRpcRequest($method, $contentType, $body)
    {
        if ($method !== 'POST' || !self::isJsonType($contentType)) return null;
        if ($body === '' || strlen($body) > self::MCP_BODY_MAX_BYTES) return null;

        $parsed = self::jsonDecode($body);
        if (!self::isRecord($parsed) || self::prop($parsed, 'jsonrpc') !== '2.0' || !is_string(self::prop($parsed, 'method'))) {
            return null;
        }

        $hasId = self::has($parsed, 'id');
        $id = $hasId ? $parsed->id : null;
        if ($id !== null && !is_string($id) && !is_int($id) && !is_float($id)) return null;

        $params = self::prop($parsed, 'params');
        return [
            'hasId' => $hasId,
            'id' => $id,
            'method' => $parsed->method,
            'params' => self::isRecord($params) ? $params : null,
        ];
    }

    // A byte search, not a parse: a key hidden behind JSON escapes is the client hiding its own credential.
    // Each key as JSON spells it, and as PHP's encoder writes `/` (`\/`).
    private static function credentialNeedles()
    {
        $needles = [];
        foreach ([self::MCP_X402_META, self::MCP_DNA_KEY_META, self::MCP_KEY_ARGUMENT] as $key) {
            $quoted = '"' . $key . '"';
            $needles[] = $quoted;
            if (strpos($quoted, '/') !== false) $needles[] = str_replace('/', '\\/', $quoted);
        }

        return $needles;
    }

    private static function findQuoted($body, $needle)
    {
        return strpos($body, $needle) !== false;
    }

    public static function namesCredential($body)
    {
        foreach (self::credentialNeedles() as $needle) {
            if (self::findQuoted($body, $needle)) return true;
        }

        return false;
    }

    /** The first byte of a JSON body's first value, past a UTF-8 BOM and whitespace; null when there is none. */
    public static function firstValueByte($body)
    {
        return self::firstNonSpaceByte($body, strncmp($body, "\xEF\xBB\xBF", 3) === 0 ? 3 : 0);
    }

    /** The first byte past JSON whitespace, or null when there is none: for a body read in parts after its first. */
    public static function firstNonSpaceByte($body, $from = 0)
    {
        $skip = strspn($body, " \t\r\n", $from);
        return $from + $skip < strlen($body) ? $body[$from + $skip] : null;
    }

    public static function opensJson($byte)
    {
        return $byte === '{' || $byte === '[';
    }

    public static function startsAsJson($body)
    {
        return self::opensJson(self::firstValueByte($body));
    }

    /** Whether a call carries one of our credentials where liftMcpPayment takes it from. */
    private static function callCarriesCredential($call)
    {
        $params = self::prop($call, 'params');
        if (!self::isRecord($params)) return false;

        $meta = self::prop($params, '_meta');
        if (self::has($meta, self::MCP_X402_META) || self::has($meta, self::MCP_DNA_KEY_META)) return true;

        return self::prop($call, 'method') === 'tools/call'
            && self::has(self::prop($params, 'arguments'), self::MCP_KEY_ARGUMENT);
    }

    /** A JSON POST past the read cap whose bytes name a credential key: it cannot be stripped. */
    public static function oversizedCallNamesCredential($method, $contentType, $body)
    {
        if ($method !== 'POST' || !self::isJsonType($contentType) || strlen($body) <= self::MCP_BODY_MAX_BYTES) {
            return false;
        }

        return self::namesCredential($body);
    }

    /**
     * unreadCallNamesCredential: a body JSON-RPC at its top level, not read as one call
     * (a batch, another content type), whose calls carry a credential. One that will
     * not parse falls back to the byte search.
     */
    public static function unreadCallNamesCredential($rpc, $body)
    {
        if ($rpc !== null || $body === '' || !self::startsAsJson($body)) return false;

        $readable = strlen($body) <= self::MCP_BODY_MAX_BYTES;
        $parsed = $readable ? self::jsonDecode($body) : null;
        if ($parsed === null) {
            // PHP's objects refuse a key JSON.parse reads (one starting with \u0000), which could hide an
            // escaped credential from the byte search: the same body read as arrays still shows it.
            $arrays = $readable ? json_decode(strncmp($body, "\xEF\xBB\xBF", 3) === 0 ? substr($body, 3) : $body, true) : null;
            if (is_array($arrays)) return self::arraysCarryCredential($arrays);

            return self::findQuoted($body, '"jsonrpc"') && self::namesCredential($body);
        }

        foreach (is_array($parsed) ? $parsed : [$parsed] as $item) {
            // Present, whatever its value: `"jsonrpc": null` is still a call's shape, as `'jsonrpc' in item` reads it.
            if (self::isRecord($item) && self::has($item, 'jsonrpc') && self::callCarriesCredential($item)) {
                return true;
            }
        }

        return false;
    }

    /** callCarriesCredential over a body json_decode could read only as arrays: one call, or a batch of them. */
    private static function arraysCarryCredential(array $parsed)
    {
        $calls = $parsed !== [] && array_keys($parsed) === range(0, count($parsed) - 1) ? $parsed : [$parsed];
        foreach ($calls as $call) {
            if (!is_array($call) || !array_key_exists('jsonrpc', $call) || !is_array($call['params'] ?? null)) continue;

            $params = $call['params'];
            $meta = is_array($params['_meta'] ?? null) ? $params['_meta'] : [];
            if (array_key_exists(self::MCP_X402_META, $meta) || array_key_exists(self::MCP_DNA_KEY_META, $meta)) return true;

            $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
            if (($call['method'] ?? null) === 'tools/call' && array_key_exists(self::MCP_KEY_ARGUMENT, $args)) return true;
        }

        return false;
    }

    /** recordableName: no query, fragment or userinfo in what the record keeps. */
    public static function recordableName($name)
    {
        if ($name === null || $name === '') return null;

        $base = preg_split('/[?#]/', $name, 2)[0];
        if (preg_match('~^([A-Za-z][A-Za-z0-9+.\-]*://)[^/@]*@(.*)$~sD', $base, $m)) return $m[1] . $m[2];

        return $base;
    }

    private static function bounded($value, $max)
    {
        if (is_string($value) && $value !== '' && strlen($value) <= $max && preg_match('/^[\x20-\x7e]+$/D', $value)) {
            return $value;
        }

        return null;
    }

    private static function nameInCall(array $rpc)
    {
        $params = $rpc['params'];
        if ($params === null) return null;

        if ($rpc['method'] === 'resources/read') return self::recordableName(self::stringOrNull(self::prop($params, 'uri')));
        if ($rpc['method'] === 'tools/call' || $rpc['method'] === 'prompts/get') {
            return self::stringOrNull(self::prop($params, 'name'));
        }

        return null;
    }

    /** mcpFactsOf: the body when one call was read, the Mcp-* mirrors otherwise, never a mix. */
    public static function mcpFactsOf(callable $getHeader, $rpc, array $excluded)
    {
        $mirror = function ($name) use ($getHeader, $excluded) {
            return in_array($name, $excluded, true) ? null : $getHeader($name);
        };

        if ($rpc !== null) {
            $method = self::bounded($rpc['method'], self::MCP_METHOD_MAX_LENGTH);
            $tool = self::bounded(self::nameInCall($rpc), self::MCP_NAME_MAX_LENGTH);
        } else {
            $method = self::bounded($mirror('mcp-method'), self::MCP_METHOD_MAX_LENGTH);
            $tool = self::bounded(self::recordableName($mirror('mcp-name')), self::MCP_NAME_MAX_LENGTH);
        }

        if ($method === null && $tool === null) return null;

        $facts = [];
        if ($method !== null) $facts['method'] = $method;
        if ($tool !== null) $facts['tool'] = $tool;
        $facts['source'] = $rpc !== null ? 'body' : 'headers';
        return $facts;
    }

    /**
     * liftMcpPayment: the call's payment as the headers the worker reads, and the
     * body without it (null when unchanged). The third value is true for a call
     * that changed but will not encode again, such as one holding `1e999`, which
     * PHP reads as INF: it cannot be stripped, so it is refused like an unread one.
     */
    public static function liftMcpPayment(array $rpc)
    {
        $params = $rpc['params'];
        if ($params === null) return [[], null, false];

        $lifted = [];
        $meta = self::isRecord(self::prop($params, '_meta')) ? clone $params->_meta : null;
        $args = self::isRecord(self::prop($params, 'arguments')) ? clone $params->arguments : null;
        $changed = false;

        if ($meta !== null && property_exists($meta, self::MCP_X402_META)) {
            $payment = $meta->{self::MCP_X402_META};
            if (self::isRecord($payment)) {
                $encoded = self::jsonEncode($payment);
                if ($encoded === null) return [[], null, true];
                $lifted['payment-signature'] = base64_encode($encoded);
            }
            unset($meta->{self::MCP_X402_META});
            $changed = true;
        }

        if ($meta !== null && property_exists($meta, self::MCP_DNA_KEY_META)) {
            $key = self::stringOrNull($meta->{self::MCP_DNA_KEY_META});
            if ($key !== null) $lifted['payment-authorization'] = 'Payment ' . $key;
            unset($meta->{self::MCP_DNA_KEY_META});
            $changed = true;
        }

        if ($rpc['method'] === 'tools/call' && $args !== null && property_exists($args, self::MCP_KEY_ARGUMENT)) {
            $key = self::stringOrNull($args->{self::MCP_KEY_ARGUMENT});
            if ($key !== null && !isset($lifted['payment-authorization'])) {
                $lifted['payment-authorization'] = 'Payment ' . $key;
            }
            unset($args->{self::MCP_KEY_ARGUMENT});
            $changed = true;
        }

        if (!$changed) return [$lifted, null, false];

        $originParams = new \stdClass();
        foreach (get_object_vars($params) as $k => $v) {
            if ($k !== '_meta' && $k !== 'arguments') $originParams->{$k} = $v;
        }
        if ($args !== null) $originParams->arguments = $args;
        if ($meta !== null && get_object_vars($meta) !== []) $originParams->_meta = $meta;

        $call = (object) ['jsonrpc' => '2.0', 'method' => $rpc['method'], 'params' => $originParams];
        if ($rpc['hasId']) $call->id = $rpc['id'];
        $body = self::jsonEncode($call);
        return $body === null ? [[], null, true] : [$lifted, $body, false];
    }

    /**
     * mcpCarriageOf: everything revision 3 reads off a request. `$body` is null for
     * one too large to hold, whose credential search `$streamed` already holds.
     */
    public static function mcpCarriageOf($method, callable $getHeader, $body, array $excluded, $streamed = null)
    {
        $contentType = $getHeader('content-type');
        $rpc = $body !== null ? self::readJsonRpcRequest($method, $contentType, $body) : null;
        $facts = self::mcpFactsOf($getHeader, $rpc, $excluded);
        $lifted = [];
        $originBody = null;
        $unencodable = false;
        if ($rpc !== null) list($lifted, $originBody, $unencodable) = self::liftMcpPayment($rpc);

        $mirrored = self::stringOrNull($getHeader(self::MCP_DNA_KEY_HEADER));
        if ($mirrored !== null && !isset($lifted['payment-authorization'])) {
            $lifted['payment-authorization'] = 'Payment ' . $mirrored;
        }

        if ($streamed !== null) {
            $tooLarge = $streamed['too_large'] && $streamed['names_credential'];
            $notOneCall = !$tooLarge && $streamed['names_credential'] && $streamed['jsonrpc'];
        } else {
            $tooLarge = self::oversizedCallNamesCredential($method, $contentType, $body);
            $notOneCall = !$tooLarge && ($unencodable || self::unreadCallNamesCredential($rpc, $body));
        }

        return [
            'rpc' => $rpc,
            'facts' => $facts,
            'lifted' => $lifted,
            'origin_body' => $originBody,
            'unreadable_credential' => $tooLarge || $notOneCall,
            'unreadable_reason' => $tooLarge ? 'too-large' : ($notOneCall ? 'not-one-call' : null),
        ];
    }

    /** liftedPaymentToForward: a header the client sent wins over the body, family by family. */
    public static function liftedPaymentToForward(array $sent, array $lifted)
    {
        $out = [];
        foreach ([['payment-signature', 'x-payment'], ['payment-authorization']] as $family) {
            $sentOne = false;
            foreach ($family as $name) {
                if (isset($sent[$name])) $sentOne = true;
            }
            if ($sentOne) continue;

            foreach ($family as $name) {
                if (isset($lifted[$name])) $out[$name] = $lifted[$name];
            }
        }

        return $out;
    }

    // ── The payload (extractEdgeRequest) ─────────────────────────────────────

    public static function contentDigest($body)
    {
        return 'sha-256=:' . base64_encode(hash('sha256', $body, true)) . ':';
    }

    /**
     * The decision payload, and the MCP carriage when revision 3 read one.
     * $req: method, url, host, ip, secure, timestamp, entries, and either `body`
     * (the bytes) or `streamed` (digest and credential search of a body too large
     * to hold), or `body_unavailable` when PHP consumed it (multipart).
     */
    public static function extract(array $req, array $opts)
    {
        $revision = $opts['revision'];
        $exclude = $opts['exclude'];
        $byName = self::lookup($req['entries']);
        $forwardsAll = $revision >= self::FORWARDS_ALL_SINCE;
        $forwarded = $forwardsAll
            ? self::forwardAll($req['entries'], $exclude, self::HEADER_LENGTH_CAPS)
            : self::allowlisted($byName);
        $headers = $forwarded['headers'];
        $dropped = $forwarded['droppedHeaders'];

        foreach ([[self::PAY_SESSION_COOKIE, self::PAY_SESSION_HEADER], [self::PERSON_PASS_COOKIE, self::PERSON_PASS_HEADER]] as $own) {
            $value = self::readCookie($byName['cookie'] ?? null, $own[0]);
            if ($value !== null && $value !== '' && strlen($value) <= self::COOKIE_TOKEN_MAX) $headers[$own[1]] = $value;
        }

        // Overwritten whenever there is a body or a claimed digest: a forged one never passes through.
        $streamed = $req['streamed'] ?? null;
        $body = null;
        if (!empty($req['body_unavailable'])) {
            // Named, not just removed: unnamed, a signature over it reads as covering a header never sent.
            if (isset($headers['content-digest'])) {
                unset($headers['content-digest']);
                $dropped[] = 'content-digest';
            }
        } elseif ($streamed !== null) {
            $headers['content-digest'] = $streamed['digest'];
        } else {
            $body = $req['body'] ?? '';
            if ($body !== '' || isset($headers['content-digest'])) $headers['content-digest'] = self::contentDigest($body);
        }

        $mcp = null;
        if ($revision >= self::CARRIES_MCP_SINCE) {
            $getHeader = function ($name) use ($byName) {
                return $byName[$name] ?? null;
            };
            $mcp = self::mcpCarriageOf($req['method'], $getHeader, $body ?? '', $exclude['headers'], $streamed);
        }

        $lifted = self::liftedPaymentToForward($byName, $mcp !== null ? $mcp['lifted'] : []);
        foreach ($lifted as $name => $value) {
            // The site's exclusion binds a lifted credential as it binds the header.
            if (in_array($name, $exclude['headers'], true)) continue;

            $cap = self::HEADER_LENGTH_CAPS[$name] ?? null;
            if ($cap !== null && strlen($value) > $cap) {
                $dropped[] = $name;
            } else {
                $headers[$name] = $value;
            }
        }

        $payload = [
            'ip' => $req['ip'],
            'headerSet' => self::FORWARDED_HEADER_SET,
            'adapterSet' => $revision,
            'secure' => $req['secure'],
            'method' => $req['method'],
            'url' => $req['url'],
            'host' => $req['host'],
            'timestamp' => $req['timestamp'],
            'headers' => $headers,
        ];
        if ($payload['ip'] === null) unset($payload['ip']);
        if ($dropped !== []) $payload['droppedHeaders'] = array_slice($dropped, 0, self::FORWARDED_MAX_NAMES);
        if ($forwardsAll) {
            $payload['cookies'] = $forwarded['cookies'];
            $payload += self::withheldOf($exclude, $forwarded['droppedUnlisted']);
        }
        if ($forwarded['droppedCookies'] !== []) $payload['droppedCookies'] = $forwarded['droppedCookies'];
        if ($mcp !== null && $mcp['facts'] !== null) $payload['mcp'] = $mcp['facts'];
        if (!empty($opts['debug'])) $payload['debugHeaders'] = self::debugHeadersOf($req['entries'], $exclude['headers']);

        return [$payload, $mcp];
    }

    /**
     * The payload as the wire carries it. Header and cookie values are bytes, which
     * fetch's Headers reads as Latin-1, so each byte becomes the code point it names;
     * every name => value map becomes a JSON object even when empty.
     */
    public static function encodePayload(array $payload)
    {
        $wire = $payload;
        foreach (['headers', 'cookies', 'debugHeaders'] as $map) {
            if (!isset($wire[$map])) continue;

            $object = new \stdClass();
            foreach ($wire[$map] as $name => $value) {
                $object->{self::latin1ToUtf8((string) $name)} = self::latin1ToUtf8($value);
            }
            $wire[$map] = $object;
        }
        $wire['url'] = self::latin1ToUtf8($wire['url']);
        $wire['host'] = self::latin1ToUtf8($wire['host']);
        if (isset($wire['mcp'])) $wire['mcp'] = (object) $wire['mcp'];
        foreach (['droppedUnlisted', 'excluded'] as $record) {
            if (isset($wire[$record])) $wire[$record] = (object) $wire[$record];
        }

        return self::jsonEncode((object) $wire);
    }

    public static function latin1ToUtf8($s)
    {
        if (!preg_match('/[\x80-\xff]/', $s)) return $s;

        return preg_replace_callback('/[\x80-\xff]/', function ($m) {
            $code = ord($m[0]);
            return chr(0xc0 | ($code >> 6)) . chr(0x80 | ($code & 0x3f));
        }, $s);
    }

    // ── Answers (payment-response.ts, edge-response.ts) ──────────────────────

    /** The last place before PHP's header table: a CR or LF through here is response splitting. Dropped, never escaped. */
    public static function headerSafe($name, $value)
    {
        if (!is_string($name) || !is_string($value)) return false;
        if (preg_match("/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/D", $name) !== 1) return false;

        return preg_match('/^[\x20-\x7e]{1,8192}$/D', $value) === 1;
    }

    /** headerSafePaymentHeaders: name => value, in the order the instruction lists them. */
    public static function headerSafePaymentHeaders($headers)
    {
        $safe = [];
        if (!self::isRecord($headers)) return $safe;

        foreach (get_object_vars($headers) as $name => $value) {
            if (self::headerSafe((string) $name, $value)) $safe[(string) $name] = $value;
        }

        return $safe;
    }

    public static function paymentEdgeMode($status)
    {
        if ($status === 402) return 'payment-required';
        if ($status >= 300 && $status <= 399) return 'payment-redirect';
        if ($status === 200) return 'payment-stub';

        return 'fail-closed';
    }

    /** A built answer: headers as [name, value] pairs, later names winning, as a JS object literal spreads. */
    private static function answer($status, $body, array $headers, $mode)
    {
        $headers[] = ['x-d3-edge', $mode];
        $hasType = false;
        foreach ($headers as $pair) {
            if (strtolower($pair[0]) === 'content-type') $hasType = true;
        }

        return ['status' => $status, 'body' => $body, 'headers' => $headers, 'mode' => $mode, 'content_type' => $hasType];
    }

    private static function paymentHeaderPairs($payment)
    {
        $pairs = [];
        foreach (self::headerSafePaymentHeaders(self::prop($payment, 'headers')) as $name => $value) {
            $pairs[] = [$name, $value];
        }

        return $pairs;
    }

    /** The MCP binding answers in band: a 200 with the result, whatever the status says. */
    private static function jsonRpcAnswer($payment, $mode, $id)
    {
        $body = self::prop($payment, 'body');
        $result = is_string($body) ? self::jsonDecode($body) : null;
        if ($result === null) return self::paymentUnavailableAnswer();

        $headers = array_merge([['content-type', self::JSON_TYPE], ['cache-control', 'no-store']], self::paymentHeaderPairs($payment));
        return self::answer(200, self::jsonEncode((object) ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]), $headers, $mode);
    }

    /** buildPaymentResponse. `$rpc` is the call read off the request, or null when none was; a notification has no id to answer. */
    public static function buildPaymentAnswer($payment, $mode, $rpc = null)
    {
        if (self::prop($payment, 'bodyKind') === 'json-rpc' && $rpc !== null && $rpc['hasId']) {
            return self::jsonRpcAnswer($payment, $mode, $rpc['id']);
        }

        $status = self::prop($payment, 'status');
        $status = is_int($status) || (is_float($status) && floor($status) === $status) ? (int) $status : 502;
        $headers = [];
        // A redirect carries no content type: a JSON type on it misleads the client that follows it.
        if (!($status >= 300 && $status <= 399)) $headers[] = ['content-type', self::JSON_TYPE];
        $headers[] = ['cache-control', 'no-store'];
        $headers = array_merge($headers, self::paymentHeaderPairs($payment));
        $body = self::prop($payment, 'body');
        return self::answer($status, is_string($body) ? $body : null, $headers, $mode);
    }

    /** blockResponse: the 403 every adapter answers, with the rule and verdict that decided. */
    public static function blockAnswer($decision, $mode)
    {
        $verdict = self::isRecord(self::prop($decision, 'verdict')) ? $decision->verdict : null;
        $body = ['blocked' => true];
        if (is_string(self::prop($decision, 'ruleId'))) $body['ruleId'] = $decision->ruleId;
        if (is_string(self::prop($verdict, 'tier'))) $body['tier'] = $verdict->tier;
        if (is_string(self::prop($verdict, 'identity'))) $body['identity'] = $verdict->identity;
        return self::answer(403, self::jsonEncode((object) $body), [['content-type', self::JSON_TYPE]], $mode);
    }

    public static function paymentUnavailableAnswer()
    {
        return self::answer(
            502,
            '{"error":"payment_unavailable"}',
            [['content-type', self::JSON_TYPE], ['cache-control', 'no-store']],
            'fail-closed'
        );
    }

    /** unreadableCallResponse: a call we could not read that names our credential. */
    public static function unreadableCallAnswer($reason)
    {
        $tooLarge = $reason !== 'not-one-call';
        return self::answer(
            $tooLarge ? 413 : 400,
            $tooLarge
                ? '{"error":"mcp_call_too_large"}'
                : '{"error":"mcp_call_unreadable","detail":"Send one JSON-RPC request per call, as application/json."}',
            [['content-type', self::JSON_TYPE], ['cache-control', 'no-store']],
            'fail-closed'
        );
    }

    /** privateCacheControl: a receipt or our Set-Cookie is one visitor's, so no shared cache holds it. */
    public static function privateCacheControl($origin)
    {
        $directives = [];
        foreach (explode(',', (string) $origin) as $part) {
            $trimmed = self::trim($part);
            if ($trimmed !== '') $directives[] = $trimmed;
        }
        if ($directives === []) return 'private';

        $shared = null;
        foreach ($directives as $i => $directive) {
            // Only a bare `private` keeps a shared cache out: `private="set-cookie"` lets it store the page.
            $lowered = strtolower($directive);
            if ($lowered === 'private' || $lowered === 'no-store') return implode(', ', $directives);
            if ($lowered === 'public' && $shared === null) $shared = $i;
        }
        if ($shared === null) return 'private, ' . implode(', ', $directives);

        $directives[$shared] = 'private';
        return implode(', ', $directives);
    }

    // ── The origin's MCP answer (mcp-response.ts) ────────────────────────────

    private static function withKeyArgument($tool)
    {
        if (!self::isRecord($tool)) return $tool;

        $schema = self::isRecord(self::prop($tool, 'inputSchema')) ? clone $tool->inputSchema : (object) ['type' => 'object'];
        $properties = self::isRecord(self::prop($schema, 'properties')) ? clone $schema->properties : new \stdClass();
        $properties->{self::MCP_KEY_ARGUMENT} = self::mcpKeyArgumentSchema();
        $schema->properties = $properties;
        $out = clone $tool;
        $out->inputSchema = $schema;
        return $out;
    }

    /** rewriteResult: the result with our _meta and, on tools/list, the key argument; null leaves it alone. */
    public static function rewriteResult($body, $meta, $listsTools)
    {
        $parsed = self::jsonDecode($body);
        if (!self::isRecord($parsed) || self::prop($parsed, 'jsonrpc') !== '2.0' || !self::isRecord(self::prop($parsed, 'result'))) {
            return null;
        }

        $result = clone $parsed->result;
        if ($meta !== null) {
            $merged = self::isRecord(self::prop($result, '_meta')) ? clone $result->_meta : new \stdClass();
            foreach (get_object_vars($meta) as $k => $v) $merged->{$k} = $v;
            $result->_meta = $merged;
        }

        if ($listsTools && is_array(self::prop($result, 'tools'))) {
            $result->tools = array_map([self::class, 'withKeyArgument'], $result->tools);
        }

        $out = clone $parsed;
        $out->result = $result;
        return self::jsonEncode($out);
    }

    /** The edits withMcpResult makes, or null when it would pass the answer untouched. */
    public static function mcpResultEdits($method, $meta, $keyArgument)
    {
        $hasMeta = self::isRecord($meta) && get_object_vars($meta) !== [];
        $listsTools = $keyArgument && $method === 'tools/list';
        if (!$hasMeta && !$listsTools) return null;

        return ['meta' => $hasMeta ? $meta : null, 'lists_tools' => $listsTools];
    }

    // ── The report (types.ts ResponseReport) ─────────────────────────────────

    /** `new URL('/v1/report', endpoint)`: the endpoint's origin, this path. */
    public static function reportUrl($endpoint)
    {
        return preg_match('~^(https?://[^/?#]+)~i', (string) $endpoint, $m) ? $m[1] . '/v1/report' : null;
    }

    /** pathOf: the URL's path, without the query. */
    public static function pathOf($url)
    {
        $query = strpos($url, '?');
        return $query === false ? $url : substr($url, 0, $query);
    }
}
