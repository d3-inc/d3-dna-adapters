<?php
// DNA in a PHP request: reads it, asks DNA, then answers or lets WordPress run
// with DNA's credentials gone. Protocol.php holds the contract; this is the I/O.
// WordPress is the origin here, and it reads the request from PHP's
// superglobals, so those are what get stripped.

namespace D3\Dna;

final class Runtime
{
    // Our build of this plugin. A copy you change sends a type of its own (PROTOCOL.md, Naming your adapter).
    const DNA_ADAPTER = 'wordpress:1.0.0';

    const DECISION_MAX_BYTES = 4194304;
    const BODY_CHUNK = 65536;
    const KEY_ARGUMENT_MEMORY_S = 300;

    // WordPress's login, post-password and WooCommerce session cookies, named by a per-site hash, so no exclusion list can name them.
    const WORDPRESS_SESSION_COOKIE = '/^(?:wordpress_(?:sec_|logged_in_)?|wordpressuser_|wordpresspass_|wp-postpass_|wp_woocommerce_session_)[0-9a-f]{32}$/D';
    // The same cookies when a site names them itself, in wp-config.php.
    const WORDPRESS_COOKIE_CONSTANTS = ['AUTH_COOKIE', 'SECURE_AUTH_COOKIE', 'LOGGED_IN_COOKIE', 'USER_COOKIE', 'PASS_COOKIE'];

    // Headers that describe WordPress's bytes, which a rewritten MCP result no longer is.
    const BYTE_HEADERS = ['Content-Length', 'Content-Digest', 'Repr-Digest', 'Content-MD5', 'ETag'];

    /** This request's state once DNA decided it; null before, and on a request DNA never asked about. */
    private static $state = null;
    private static $settings = null;

    // ── Entry ────────────────────────────────────────────────────────────────

    /** Asks DNA about this request and answers as it says. Never throws: a failure fails open, except for a request that pays. */
    public static function run()
    {
        try {
            self::access();
        } catch (\Throwable $e) {
            self::logEvery('access error', 10, 'the request handling failed, so this request fails open unless it pays: ' . $e->getMessage());
            self::containAccessError();
        }
    }

    /** After access() threw at whatever point: strip the request, and refuse it if it may pay. */
    private static function containAccessError()
    {
        $paying = true;
        try {
            $byName = Protocol::lookup(self::headerEntriesFromServer($_SERVER));
            $paying = self::mayPayAfterError($byName, self::queryOf(self::requestTarget($_SERVER)), self::readBody(
                $_SERVER['REQUEST_METHOD'] ?? 'GET',
                $byName['content-type'] ?? null
            ));
            self::stripForOrigin();
        } catch (\Throwable $e) {
            self::logEvery('contain error', 10, 'cannot strip this request, so it is refused: ' . $e->getMessage());
        }

        if ($paying) self::send(Protocol::paymentUnavailableAnswer());
        if (!headers_sent()) header('x-d3-edge: fail-open');
    }

    /** Whether a request may pay, read loosely: a key in a JSON body counts, read as a call or not. */
    public static function mayPayAfterError(array $byName, $query, array $body)
    {
        if (Protocol::presentsPayment($byName, $query, [])) return true;
        if (($byName[Protocol::MCP_DNA_KEY_HEADER] ?? '') !== '') return true;
        if (!empty($body['streamed'])) return $body['streamed']['names_credential'];

        $data = $body['data'] ?? '';
        return Protocol::startsAsJson($data) && Protocol::namesCredential($data);
    }

    private static function access()
    {
        $settings = self::settings();
        if ($settings['endpoint'] === null) {
            self::stripForOrigin();
            header('x-d3-edge: disabled');
            return;
        }

        $target = self::requestTarget($_SERVER);
        $entries = self::headerEntriesFromServer($_SERVER);
        $byName = Protocol::lookup($entries);
        $method = self::restMethod(strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')), $target, $_GET, $_SERVER);
        $body = self::readBody($method, $byName['content-type'] ?? null);
        $host = self::decidedHost(self::requestHost($_SERVER), self::siteHosts());
        $requestId = self::requestId();
        $exclude = [
            'headers' => $settings['exclude']['headers'],
            'cookies' => self::withWordPressSessionCookies($settings['exclude']['cookies'], $byName['cookie'] ?? null),
        ];

        list($payload, $mcp) = Protocol::extract([
            'method' => $method,
            'url' => $target,
            'host' => $host,
            'ip' => isset($_SERVER['REMOTE_ADDR']) && $_SERVER['REMOTE_ADDR'] !== '' ? (string) $_SERVER['REMOTE_ADDR'] : null,
            'secure' => self::isSecure($_SERVER),
            'timestamp' => microtime(true),
            'entries' => $entries,
            'body' => $body['data'] ?? null,
            'streamed' => $body['streamed'] ?? null,
            'body_unavailable' => !empty($body['unavailable']),
        ], ['revision' => Protocol::ADAPTER_SET, 'exclude' => $exclude, 'debug' => $settings['debug_log_raw_payload']]);
        $payload['requestId'] = $requestId;

        self::$state = [
            'request_id' => $requestId,
            'host' => $host,
            'path' => Protocol::pathOf($target),
            'method' => $method,
            'mode' => null,
            'answer' => null,
            'no_report' => false,
            'payment_headers' => [],
            'appended' => false,
            'mcp_edits' => null,
            'rewrite' => null,
            'decided_at' => null,
            'shutting_down' => false,
        ];
        register_shutdown_function(function () {
            self::$state['shutting_down'] = true;
            // Registered from inside a shutdown function, so it runs after every other one,
            // WordPress's own output flush included: finishing the request first would cut it off.
            register_shutdown_function([self::class, 'report']);
        });

        if ($mcp !== null && $mcp['unreadable_credential']) {
            self::send(Protocol::unreadableCallAnswer($mcp['unreadable_reason']));
        }

        $paying = Protocol::presentsPayment($byName, self::queryOf($target), $payload['headers']);
        $res = self::decide($settings, $payload, $paying ? $settings['payment_timeout_ms'] : $settings['timeout_ms']);
        self::$state['decided_at'] = microtime(true);

        $decision = self::validDecision($res);
        if ($decision === null) {
            self::logDecisionFailure($res);
            // An endpoint that did not answer at all is not asked again for the report.
            if ($res['status'] === null) self::$state['no_report'] = true;
            // A paying request never falls open: the page is priced and the charge may already have landed.
            if ($paying) self::send(Protocol::paymentUnavailableAnswer());
            if ($settings['fail_mode'] === 'closed') self::send(Protocol::blockAnswer(null, 'fail-closed'));

            self::toOrigin($mcp);
            self::passOn('fail-open');
            return;
        }

        if (property_exists($decision, 'mcpKeyArgument')) self::rememberKeyArgument($host, $decision->mcpKeyArgument === true);

        if ($decision->action === 'block') self::send(Protocol::blockAnswer($decision, 'block'));

        $payment = Protocol::isRecord($decision->payment ?? null) ? $decision->payment : null;
        if ($payment !== null && property_exists($payment, 'status')) {
            $status = is_int($payment->status) ? $payment->status : 502;
            self::send(Protocol::buildPaymentAnswer($payment, Protocol::paymentEdgeMode($status), $mcp['rpc'] ?? null));
        }

        self::toOrigin($mcp);
        self::$state['payment_headers'] = Protocol::headerSafePaymentHeaders($payment->headers ?? null);
        if ($mcp !== null && $mcp['rpc'] !== null) {
            $keyArgument = property_exists($decision, 'mcpKeyArgument') ? $decision->mcpKeyArgument === true : self::keyArgumentOn($host);
            self::$state['mcp_edits'] = Protocol::mcpResultEdits($mcp['rpc']['method'], $payment->meta ?? null, $keyArgument);
            if (self::$state['mcp_edits'] !== null) {
                self::$state['rewrite'] = ['held' => '', 'passing' => false, 'decided' => false];
            }
        }
        if ($paying || self::$state['payment_headers'] !== [] || Protocol::isRecord($payment->meta ?? null)) self::keepOutOfPageCaches();

        // From revision 2 DNA may pass before working out who is asking: no verdict, no headers.
        $verdict = $decision->verdict ?? null;
        if (Protocol::isRecord($verdict)) {
            $_SERVER['HTTP_X_D3_TIER'] = is_string($verdict->tier ?? null) ? $verdict->tier : '';
            $_SERVER['HTTP_X_D3_IDENTITY'] = is_string($verdict->identity ?? null) ? $verdict->identity : '';
        }

        self::passOn('pass');
    }

    /** The decision, or null for anything that is not a 2xx carrying `pass` or `block`. */
    private static function validDecision(array $res)
    {
        if ($res['status'] === null || $res['status'] < 200 || $res['status'] >= 300) return null;

        $decision = Protocol::jsonDecode($res['body']);
        if (!Protocol::isRecord($decision)) return null;

        $action = $decision->action ?? null;
        return $action === 'pass' || $action === 'block' ? $decision : null;
    }

    private static function logDecisionFailure(array $res)
    {
        $reason = $res['error'] ?? ($res['status'] !== null ? 'HTTP ' . $res['status'] : 'invalid decision');
        // A dead key fails open and looks like a working site: this line is how it gets found.
        if ($res['status'] === 401 || $res['status'] === 403) {
            $reason .= ', check DNA_API_KEY: ' . substr((string) $res['body'], 0, 200);
        }
        // Keyed by the kind of failure: curl's message names the milliseconds, which differ every time.
        $kind = $res['status'] !== null ? 'HTTP ' . $res['status'] : 'curl ' . $res['errno'];
        self::logEvery('decision ' . $kind, 10, 'decision call failed (' . $reason . '), and again until this stops');
    }

    /**
     * WordPress runs next, and DNA's half of the response goes on as WordPress's
     * output leaves: through an output handler rather than header_register_callback,
     * whose one slot another plugin's would take, or DNA's take from the site's own.
     */
    private static function passOn($mode)
    {
        self::$state['mode'] = $mode;
        header('x-d3-edge: ' . $mode);
        ob_start([self::class, 'onOutput'], 1);
    }

    /**
     * A page cache plugin stores pages from its own buffer, which sees neither our
     * headers nor the payer, so one paid visit would serve the page free to all.
     * WP Super Cache, W3 Total Cache, WP Rocket and LiteSpeed Cache all read this.
     */
    private static function keepOutOfPageCaches()
    {
        if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
        // LiteSpeed's server-level cache, which runs without the plugin.
        header('X-LiteSpeed-Cache-Control: no-cache');
    }

    /** Also on fail-open: an endpoint we could not reach is no reason to hand the origin a credential. */
    private static function toOrigin($mcp)
    {
        self::stripForOrigin();
        if ($mcp !== null && $mcp['origin_body'] !== null) self::replaceOriginBody($mcp['origin_body']);
    }

    // ── The request as PHP holds it ──────────────────────────────────────────

    /** The request headers PHP has, by their wire names: `HTTP_X_FOO` is `x-foo`. */
    public static function headerEntriesFromServer(array $server)
    {
        $raw = [];
        foreach ($server as $key => $value) {
            if (!is_string($key) || !is_string($value) || strncmp($key, 'HTTP_', 5) !== 0) continue;

            $raw[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
        }
        // The CGI spec puts these two outside HTTP_*; some servers send both.
        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $key => $name) {
            if (!isset($raw[$name]) && isset($server[$key]) && is_string($server[$key])) $raw[$name] = $server[$key];
        }

        return Protocol::headerEntries($raw);
    }

    public static function requestHost(array $server)
    {
        return (string) ($server['HTTP_HOST'] ?? $server['SERVER_NAME'] ?? '');
    }

    /** As WordPress's is_ssl() reads it. A forwarded proto header is the visitor's to set, so it is not read. */
    public static function isSecure(array $server)
    {
        if (isset($server['HTTPS']) && $server['HTTPS'] !== '' && strtolower((string) $server['HTTPS']) !== 'off') return true;

        return isset($server['SERVER_PORT']) && (string) $server['SERVER_PORT'] === '443';
    }

    /** Path plus query, as the agent sent it; bytes URL parsing would escape go escaped. */
    public static function requestTarget(array $server)
    {
        $uri = (string) ($server['REQUEST_URI'] ?? '');
        $uri = preg_replace('~^[A-Za-z][A-Za-z0-9+.\-]*://[^/?#]*~', '', $uri);
        $hash = strpos($uri, '#');
        if ($hash !== false) $uri = substr($uri, 0, $hash);
        if ($uri === '' || $uri[0] !== '/') $uri = '/' . $uri;

        return preg_replace_callback('/[\x00-\x20"<>\x7f-\xff]/', function ($m) {
            return sprintf('%%%02X', ord($m[0]));
        }, $uri);
    }

    /** The query of a request target: the one the payload names is the one a payment is looked for in. */
    public static function queryOf($target)
    {
        $at = strpos($target, '?');
        return $at === false ? '' : (string) substr($target, $at + 1);
    }

    /**
     * The method WordPress serves the request as. On the REST API, `?_method=`
     * or `X-HTTP-Method-Override` turn a GET into the POST that runs an MCP tool,
     * and DNA reads a GET as the free handshake: it is told the method that runs.
     */
    public static function restMethod($method, $target, array $get, array $server)
    {
        $rest = isset($get['rest_route']) || preg_match('~^(?:/index\.php)?/wp-json(?:/|$)~i', Protocol::pathOf($target)) === 1;
        $override = $get['_method'] ?? $server['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? null;
        return $rest && is_string($override) && $override !== '' ? strtoupper($override) : $method;
    }

    /**
     * The hosts this site's rules are for: DNA_HOSTS, else WordPress's own home
     * and site URLs where they are known yet. Empty when none is.
     */
    public static function siteHosts()
    {
        $hosts = Protocol::parseExclusionList(self::setting('DNA_HOSTS'), true);
        if ($hosts !== []) return $hosts;

        $urls = [];
        foreach (['WP_HOME', 'WP_SITEURL'] as $constant) {
            if (defined($constant)) $urls[] = constant($constant);
        }
        // The must-use loader and the plugin run after WordPress connects to its database; wp-config.php runs before.
        if ($urls === [] && function_exists('get_option')) $urls = [get_option('home'), get_option('siteurl')];

        foreach ($urls as $url) {
            $host = self::hostOf($url);
            if ($host !== null && !in_array($host, $hosts, true)) $hosts[] = $host;
        }

        return $hosts;
    }

    /** A URL's authority as a Host header names it: lowercase, with its port when it has one. */
    public static function hostOf($url)
    {
        $parts = is_string($url) ? parse_url($url) : false;
        if (!is_array($parts) || !isset($parts['host'])) return null;

        return strtolower($parts['host']) . (isset($parts['port']) ? ':' . $parts['port'] : '');
    }

    /**
     * The host DNA reads this site's rules by. The Host header is the visitor's
     * to write, and a server that answers any name (a default vhost, or nginx
     * routing by an absolute request target) would otherwise let a request pick
     * a host with no rules at all: one the site doesn't list is decided as its first.
     */
    public static function decidedHost($requested, array $siteHosts)
    {
        if ($siteHosts === []) return $requested;

        return in_array(rtrim(strtolower($requested), '.'), $siteHosts, true) ? $requested : $siteHosts[0];
    }

    /** The site's cookie exclusions, plus every WordPress login cookie this request carries. */
    public static function withWordPressSessionCookies(array $excluded, $cookieHeader)
    {
        $named = [];
        foreach (self::WORDPRESS_COOKIE_CONSTANTS as $constant) {
            if (defined($constant)) $named[] = (string) constant($constant);
        }

        $hash = defined('COOKIEHASH') ? (string) COOKIEHASH : '';
        foreach (Protocol::cookiesOf($cookieHeader) as $cookie) {
            $name = $cookie[0];
            $session = preg_match(self::WORDPRESS_SESSION_COOKIE, $name) === 1 || in_array($name, $named, true)
                || ($hash !== '' && substr($name, -strlen($hash)) === $hash);
            if ($session && !in_array($name, $excluded, true)) $excluded[] = $name;
        }

        return $excluded;
    }

    public static function requestId()
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /**
     * The body as the payload needs it: `data` whole when it is small enough to
     * read as a call, `streamed` (digest and credential search) past that, or
     * `unavailable` when PHP consumed it into $_POST and $_FILES (multipart).
     */
    public static function readBody($method, $contentType)
    {
        $in = @fopen('php://input', 'rb');
        $first = '';
        while ($in !== false && strlen($first) <= Protocol::MCP_BODY_MAX_BYTES && !feof($in)) {
            $chunk = fread($in, self::BODY_CHUNK);
            if ($chunk === false || $chunk === '') break;
            $first .= $chunk;
        }

        if (strlen($first) <= Protocol::MCP_BODY_MAX_BYTES) {
            if ($in !== false) fclose($in);
            // PHP empties php://input only when it parsed a multipart body: one without a boundary it leaves whole.
            $consumed = $first === '' && ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0)) > 0
                && stripos((string) $contentType, 'multipart/form-data') === 0;
            return $consumed ? ['unavailable' => true] : ['data' => $first];
        }

        // Past the read cap: hashed as it streams, and searched for our keys only where a call could be.
        $jsonCall = $method === 'POST' && Protocol::isJsonType($contentType);
        $looksJson = Protocol::startsAsJson($first);
        $search = $jsonCall || $looksJson;
        $digest = hash_init('sha256');
        $names = false;
        $jsonrpc = false;
        $tail = '';
        $chunk = $first;
        while ($chunk !== '' && $chunk !== false) {
            hash_update($digest, $chunk);
            if ($search) {
                // The previous chunk's tail keeps a key split across two chunks findable.
                $window = $tail . $chunk;
                $names = $names || Protocol::namesCredential($window);
                $jsonrpc = $jsonrpc || strpos($window, '"jsonrpc"') !== false;
                $tail = substr($chunk, -32);
            }
            $chunk = feof($in) ? '' : fread($in, self::BODY_CHUNK);
        }
        fclose($in);

        return ['streamed' => [
            'digest' => 'sha-256=:' . base64_encode(hash_final($digest, true)) . ':',
            'names_credential' => $names,
            'jsonrpc' => $jsonrpc && $looksJson,
            // Only a JSON POST past the read cap is streamed and still a call.
            'too_large' => $jsonCall,
        ]];
    }

    private static function serverKey($header)
    {
        return 'HTTP_' . strtoupper(str_replace('-', '_', $header));
    }

    /**
     * No credential of ours and no visitor's verdict reaches WordPress, in a
     * header, a cookie or the URL, whether DNA answered, failed, or is turned off.
     * A request with nothing of ours on it is left exactly as PHP read it.
     */
    public static function stripForOrigin()
    {
        $query = $_SERVER['QUERY_STRING'] ?? null;
        self::stripRequestCopy($_SERVER);
        // PHP fills $_ENV with the request too when variables_order lists E.
        if (!empty($_ENV)) self::stripRequestCopy($_ENV);

        // register_argc_argv hands a web request its query as argv, split on `+`.
        if (isset($_SERVER['argv']) && is_array($_SERVER['argv']) && is_string($query) && $query !== $_SERVER['QUERY_STRING']) {
            $_SERVER['argv'] = $_SERVER['QUERY_STRING'] === '' ? [] : explode('+', $_SERVER['QUERY_STRING']);
            $_SERVER['argc'] = count($_SERVER['argv']);
        }

        // By the name PHP made of it, which turns `__Host-d3person ` into `__Host-d3person_`: still ours.
        foreach (array_keys($_COOKIE ?? []) as $name) {
            if (Protocol::isNamespaceCookie((string) $name)) unset($_COOKIE[$name], $_REQUEST[$name]);
        }

        // PHP's own names too: it reads `d3pay.handoff` as `d3pay_handoff`.
        foreach ($_GET ?? [] as $name => $value) {
            if (!Protocol::isNamespaceParam((string) $name)) continue;

            unset($_GET[$name]);
            if (isset($_REQUEST[$name]) && $_REQUEST[$name] === $value) unset($_REQUEST[$name]);
        }
    }

    /** One copy of the request PHP keeps ($_SERVER, $_ENV): our headers, cookies and params out of it. */
    private static function stripRequestCopy(array &$vars)
    {
        foreach (array_merge(Protocol::ORIGIN_STRIPPED_HEADERS, Protocol::VERDICT_HEADERS) as $name) {
            unset($vars[self::serverKey($name)]);
        }

        $cookie = $vars['HTTP_COOKIE'] ?? null;
        if (is_string($cookie) && Protocol::holdsOwnCookie($cookie)) {
            $kept = Protocol::stripOwnCookies($cookie);
            if ($kept === null) {
                unset($vars['HTTP_COOKIE']);
            } else {
                $vars['HTTP_COOKIE'] = $kept;
            }
        }

        // The URL as each server keeps it: Apache's rewrite keeps the query it redirected, IIS the original URL.
        $urls = ['REQUEST_URI', 'UNENCODED_URL', 'HTTP_X_ORIGINAL_URL', 'HTTP_X_REWRITE_URL'];
        $queries = ['QUERY_STRING', 'REDIRECT_QUERY_STRING'];
        foreach (array_merge($urls, $queries) as $key) {
            if (!isset($vars[$key]) || !is_string($vars[$key])) continue;

            $stripped = in_array($key, $queries, true)
                ? (string) substr(Protocol::stripPayParams('?' . $vars[$key]), 1)
                : Protocol::stripPayParams($vars[$key]);
            if ($stripped !== $vars[$key]) $vars[$key] = $stripped;
        }
    }

    /**
     * The MCP call WordPress reads, without our credential: the REST API reads
     * $HTTP_RAW_POST_DATA first, and php://input answers the same bytes to anything else.
     */
    private static function replaceOriginBody($body)
    {
        $GLOBALS['HTTP_RAW_POST_DATA'] = $body;
        $_SERVER['CONTENT_LENGTH'] = (string) strlen($body);
        unset($_SERVER['HTTP_CONTENT_DIGEST'], $_SERVER['HTTP_CONTENT_LENGTH']);
        InputStream::install($body);
    }

    // ── Asking DNA ───────────────────────────────────────────────────────────

    /**
     * POSTs the payload under a hard budget: curl's timeout covers the whole call,
     * connecting and resolving included. Returns status (null when none came back),
     * body, error and curl's error number.
     */
    private static function decide(array $settings, array $payload, $budgetMs)
    {
        $failed = function ($error, $errno = 0) {
            return ['status' => null, 'body' => null, 'error' => $error, 'errno' => $errno];
        };
        if (!function_exists('curl_init')) return $failed('PHP has no curl extension, which DNA needs to bound its call');

        $json = Protocol::encodePayload($payload);
        if ($json === null) return $failed('the payload did not encode');

        $headers = ['Content-Type: application/json', 'dna-adapter: ' . self::DNA_ADAPTER, 'Expect:'];
        if ($settings['api_key'] !== null) $headers[] = 'Authorization: Bearer ' . Protocol::trim($settings['api_key']);

        $body = '';
        $ch = curl_init($settings['endpoint']);
        curl_setopt_array($ch, self::curlOptions((int) ceil($budgetMs)) + [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $json,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use (&$body) {
                if (strlen($body) + strlen($data) > self::DECISION_MAX_BYTES) return 0;
                $body .= $data;
                return strlen($data);
            },
        ]);
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        self::closeCurl($ch);

        if ($ok === false || $status === 0) return $failed($error !== '' ? $error : 'no response', $errno);

        return ['status' => $status, 'body' => $body, 'error' => null, 'errno' => 0];
    }

    /** PHP 8 frees a handle by itself, and 8.5 deprecates closing one: a notice printed would send WordPress's headers early. */
    private static function closeCurl($ch)
    {
        if (PHP_VERSION_ID < 80000) curl_close($ch);
    }

    private static function curlOptions($budgetMs)
    {
        $options = [
            CURLOPT_TIMEOUT_MS => $budgetMs,
            CURLOPT_CONNECTTIMEOUT_MS => $budgetMs,
            // Without it, a budget under a second can turn into none on builds that time DNS out with signals.
            CURLOPT_NOSIGNAL => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        $share = self::persistentShare();
        if ($share !== null) $options[CURLOPT_SHARE] = $share;

        return $options;
    }

    /** PHP 8.5 keeps connections and TLS sessions across requests; before it, every call opens its own. */
    private static function persistentShare()
    {
        static $share = false;
        if ($share === false) {
            $share = function_exists('curl_share_init_persistent')
                ? @curl_share_init_persistent([CURL_LOCK_DATA_DNS, CURL_LOCK_DATA_CONNECT, CURL_LOCK_DATA_SSL_SESSION])
                : null;
            if ($share === false) $share = null;
        }

        return $share;
    }

    // ── Answering ────────────────────────────────────────────────────────────

    /** Our own answer, whole, in place of WordPress. Ends the request. */
    private static function send(array $answer)
    {
        if (self::$state !== null) {
            self::$state['mode'] = $answer['mode'];
            self::$state['answer'] = $answer;
        }

        while (ob_get_level() > 0 && @ob_end_clean()) {
        }
        if (headers_sent($file, $line)) {
            self::logEvery('sent early', 3600, "output from $file:$line went out before DNA, so its answers go out as that output's 200");
        } else {
            header_remove();
            // PHP would otherwise add a text/html type to a redirect.
            if (!$answer['content_type']) ini_set('default_mimetype', '');
            foreach ($answer['headers'] as $pair) header($pair[0] . ': ' . $pair[1]);
            if ($answer['body'] === null) header('Content-Length: 0');
            // After the headers: PHP turns the status into a 401 on WWW-Authenticate and a 302 on Location.
            http_response_code($answer['status']);
        }
        if ($answer['body'] !== null) echo $answer['body'];
        exit;
    }

    // ── The response WordPress sends ─────────────────────────────────────────

    /**
     * Everything WordPress prints passes here before PHP sends its headers. DNA's
     * headers go on each time until then, so one WordPress sets late is still
     * narrowed; an MCP result DNA adds to is held whole to rewrite.
     */
    public static function onOutput($chunk, $phase)
    {
        if (self::$state === null) return $chunk;
        if (!headers_sent()) self::decorate();

        // Closed before the headers left, as a download closes every buffer before it sets its own:
        // PHP's own callback puts ours on instead. Taken only for a response that needs it, since it has one slot.
        if (($phase & PHP_OUTPUT_HANDLER_FINAL) && !headers_sent() && !self::shuttingDown() && self::carriesPayment()) {
            header_register_callback([self::class, 'decorate']);
        }

        $rewrite = &self::$state['rewrite'];
        if ($rewrite === null || $rewrite['passing']) return $chunk;

        if ($phase & PHP_OUTPUT_HANDLER_CLEAN) {
            $rewrite['held'] = '';
            $chunk = '';
        }
        $final = ($phase & PHP_OUTPUT_HANDLER_FINAL) !== 0;

        if (!$rewrite['decided']) {
            // Whitespace says nothing about the answer yet: the buffer starting, an ob_clean,
            // a newline after some plugin's closing tag that output_buffering holds back.
            if (!$final && trim($chunk) === '') {
                $rewrite['held'] .= $chunk;
                return '';
            }

            $rewrite['decided'] = true;
            if (headers_sent() || !self::resultRewritable(headers_list())) {
                $rewrite['passing'] = true;
                $out = $rewrite['held'] . $chunk;
                $rewrite['held'] = '';
                return $out;
            }
            self::decorate();
        }

        $rewrite['held'] .= $chunk;
        $outgrown = strlen($rewrite['held']) > Protocol::MCP_RESULT_MAX_BYTES;

        if ($final && !$outgrown) {
            $edits = self::$state['mcp_edits'];
            $whole = $rewrite['held'];
            $rewrite['held'] = '';
            return Protocol::rewriteResult($whole, $edits['meta'], $edits['lists_tools']) ?? $whole;
        }

        // Someone flushed on purpose (a stream), or the answer outgrew the cap: what is held goes as it is.
        if (($phase & (PHP_OUTPUT_HANDLER_FLUSH | PHP_OUTPUT_HANDLER_FINAL)) || $outgrown) {
            $rewrite['passing'] = true;
            $held = $rewrite['held'];
            $rewrite['held'] = '';
            return $held;
        }

        return '';
    }

    private static function shuttingDown()
    {
        return self::$state['shutting_down'] || (function_exists('doing_action') && doing_action('shutdown'));
    }

    /** A receipt or our Set-Cookie: what makes a response one visitor's. */
    private static function carriesPayment()
    {
        return self::$state['payment_headers'] !== [];
    }

    /** DNA's headers onto WordPress's, as they stand now. The status is kept: a Location or WWW-Authenticate would move it. */
    public static function decorate()
    {
        if (self::$state === null || headers_sent()) return;

        $state = &self::$state;
        $status = http_response_code();
        header('x-d3-edge: ' . $state['mode']);

        $rewrite = $state['rewrite'];
        $rewriting = $rewrite !== null && $rewrite['decided'] && !$rewrite['passing'];
        $narrow = $state['payment_headers'] !== [] || ($rewriting && $state['mcp_edits']['meta'] !== null);
        $decorated = self::decoratedHeaders(headers_list(), $state['payment_headers'], $narrow);
        foreach ($decorated['replace'] as $name => $value) header($name . ': ' . $value, true);
        if (!$state['appended']) {
            foreach ($decorated['append'] as $pair) header($pair[0] . ': ' . $pair[1], false);
            $state['appended'] = true;
        }
        if ($rewriting) {
            foreach (self::BYTE_HEADERS as $name) header_remove($name);
        }

        if (is_int($status)) http_response_code($status);
    }

    /**
     * DNA's headers against WordPress's: Set-Cookie and the CORS list are appended,
     * the rest replace, and a paid page's caching is narrowed to one visitor.
     */
    public static function decoratedHeaders(array $headerList, array $paymentHeaders, $narrow)
    {
        $replace = [];
        $append = [];
        foreach ($paymentHeaders as $name => $value) {
            $lower = strtolower($name);
            if (in_array($lower, Protocol::MERGED_HEADERS, true)) {
                $append[] = [$lower, $value];
            } else {
                $replace[$lower] = $value;
            }
        }

        if ($narrow) {
            $cacheControl = $replace['cache-control'] ?? self::responseHeader($headerList, 'cache-control');
            $replace['cache-control'] = Protocol::privateCacheControl($cacheControl);
        }

        return ['replace' => $replace, 'append' => $append];
    }

    /** One response header from headers_list(), repeats joined; null when absent. */
    public static function responseHeader(array $headerList, $name)
    {
        $values = [];
        foreach ($headerList as $line) {
            $colon = strpos($line, ':');
            if ($colon !== false && strcasecmp(substr($line, 0, $colon), $name) === 0) {
                $values[] = Protocol::trim(substr($line, $colon + 1));
            }
        }

        return $values === [] ? null : implode(', ', $values);
    }

    private static function resultRewritable(array $headerList)
    {
        $status = http_response_code();
        if ($status === 204 || $status === 304 || ($_SERVER['REQUEST_METHOD'] ?? '') === 'HEAD') return false;
        if (!Protocol::isJsonType(self::responseHeader($headerList, 'content-type'))) return false;

        $declared = self::responseHeader($headerList, 'content-length');
        if ($declared !== null && (int) $declared > Protocol::MCP_RESULT_MAX_BYTES) return false;

        $encoding = self::responseHeader($headerList, 'content-encoding');
        if ($encoding !== null && strtolower($encoding) !== 'identity') {
            self::logEvery('encoded', 3600, 'an MCP call was answered ' . $encoding . '-encoded, so DNA could not add its receipt');
            return false;
        }

        return true;
    }

    // ── Key argument memory (mcp-response.ts) ────────────────────────────────

    /** Per server, as the packages keep it per isolate: a decision that passes early does not say. */
    private static function rememberKeyArgument($host, $on)
    {
        $key = 'key-argument ' . $host;
        // Refreshed at half its life, not per request: the flag rides every decision.
        if ($on && !Memory::holds($key, self::KEY_ARGUMENT_MEMORY_S / 2)) Memory::hold($key, self::KEY_ARGUMENT_MEMORY_S);
        if (!$on && Memory::holds($key, self::KEY_ARGUMENT_MEMORY_S)) Memory::drop($key);
    }

    private static function keyArgumentOn($host)
    {
        return Memory::holds('key-argument ' . $host, self::KEY_ARGUMENT_MEMORY_S);
    }

    // ── The report ───────────────────────────────────────────────────────────

    /**
     * After the visitor has the whole response: what they got, to /v1/report. Only
     * where PHP can end the response first (PHP-FPM, LiteSpeed); elsewhere the
     * visitor's connection would wait on it, so nothing is reported. It still holds
     * a PHP worker while it runs, so it gets the decision's budget and no more.
     */
    public static function report()
    {
        $state = self::$state;
        if ($state === null || $state['mode'] === null || $state['no_report']) return;

        $settings = self::settings();
        $url = Protocol::reportUrl($settings['endpoint']);
        if ($url === null || !function_exists('curl_init')) return;

        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        } else {
            return;
        }
        // PHP writes the session, and frees its lock for the visitor's next request, only after this returns.
        if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) session_write_close();

        $report = self::reportOf($state, headers_list(), http_response_code(), microtime(true));
        $ch = curl_init($url);
        $headers = ['Content-Type: application/json', 'Expect:'];
        if ($settings['api_key'] !== null) $headers[] = 'Authorization: Bearer ' . Protocol::trim($settings['api_key']);
        curl_setopt_array($ch, self::curlOptions((int) ceil($settings['timeout_ms'])) + [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => Protocol::jsonEncode($report),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
        ]);
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        self::closeCurl($ch);
        if ($ok === false || $status >= 300 || $status === 0) {
            self::logEvery(
                'report ' . ($status !== 0 ? $status : 'curl ' . $errno),
                60,
                'response report failed (' . ($error !== '' ? $error : 'HTTP ' . $status) . '), and again until this stops'
            );
        }
    }

    /** types.ts ResponseReport, from what PHP sent. */
    public static function reportOf(array $state, array $headerList, $status, $now)
    {
        $report = [
            'requestId' => $state['request_id'],
            'ts' => (int) floor($now * 1000),
            'host' => Protocol::latin1ToUtf8($state['host']),
            'path' => Protocol::latin1ToUtf8($state['path']),
            'method' => $state['method'],
            'mode' => $state['mode'],
        ];

        if ($state['answer'] !== null) {
            $answer = $state['answer'];
            $headers = [];
            foreach ($answer['headers'] as $pair) $headers[strtolower($pair[0])] = $pair[1];
            $report['status'] = $answer['status'];
            if (isset($headers['content-type'])) $report['contentType'] = $headers['content-type'];
            if ($answer['body'] !== null) $report['contentLength'] = strlen($answer['body']);
            $report['answer'] = (object) array_filter(['headers' => (object) $headers, 'body' => $answer['body']], function ($v) {
                return $v !== null;
            });
            return (object) $report;
        }

        if (is_int($status)) $report['status'] = $status;
        $type = self::responseHeader($headerList, 'content-type');
        if ($type !== null) $report['contentType'] = $type;
        $length = self::responseHeader($headerList, 'content-length');
        if ($length !== null && preg_match('/^\d{1,15}$/D', $length) === 1) $report['contentLength'] = (int) $length;
        if ($state['decided_at'] !== null) $report['originLatencyMs'] = (int) round(($now - $state['decided_at']) * 1000);
        return (object) $report;
    }

    // ── Settings and logging ─────────────────────────────────────────────────

    /** Read once per request: a constant in wp-config.php, else the server's environment. */
    public static function settings()
    {
        if (self::$settings === null) {
            self::$settings = Protocol::settings([self::class, 'setting']);
            $overflow = Protocol::exclusionOverflowWarning(self::$settings['exclude']);
            if ($overflow !== null) self::logEvery('exclusion overflow', 3600, $overflow);
        }

        return self::$settings;
    }

    /**
     * One setting by its DNA_* name; the SDKs' older names are not read, since a
     * WordPress site's other plugins may define them for their own use.
     */
    public static function setting($name)
    {
        if (strncmp($name, 'DNA_', 4) !== 0) return null;

        if (defined($name)) {
            $value = constant($name);
            if (is_bool($value)) return $value ? 'true' : 'false';
            return is_scalar($value) ? (string) $value : null;
        }

        $value = getenv($name);
        if (is_string($value)) return $value;

        return isset($_SERVER[$name]) && is_string($_SERVER[$name]) ? $_SERVER[$name] : null;
    }

    /** One line per key per interval, not one per request: a DNA outage would otherwise write a line for every page served. */
    public static function logEvery($key, $seconds, $message)
    {
        if (Memory::claim('log ' . $key, $seconds)) error_log('d3-dna: ' . $message);
    }
}
