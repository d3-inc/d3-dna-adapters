<?php
/**
 * Plugin Name: DNA test origin
 * Description: The site behind DNA in wordpress/test: echoes what WordPress was handed, and authors its own Set-Cookie, CORS list and caching.
 */

// A security plugin's renamed REST prefix, for the phase run.sh starts with it.
if (getenv('DNA_TEST_REST_PREFIX')) {
    add_filter('rest_url_prefix', function () {
        return getenv('DNA_TEST_REST_PREFIX');
    });
}

// Some plugin's newline after its closing tag, which output_buffering holds back.
if (isset($_SERVER['HTTP_X_TEST_STRAY_NEWLINE'])) echo "\n";

function dna_test_request_headers()
{
    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (strncmp($key, 'HTTP_', 5) === 0) $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
    }
    return $headers;
}

/** An MCP server's answer to one JSON-RPC call: a result, or the tools it lists. */
function dna_test_mcp_result($call)
{
    if (($call['method'] ?? null) === 'tools/list') {
        return ['tools' => [['name' => 'search', 'inputSchema' => ['type' => 'object', 'properties' => ['q' => ['type' => 'string']]]]]];
    }
    return ['content' => [['type' => 'text', 'text' => 'ok']], 'echo' => $call['params'] ?? null];
}

function dna_test_json($body)
{
    // As a site's own code writes JSON: floats as PHP prints them by default.
    return json_encode($body, JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

add_action('init', function () {
    if (defined('WP_CLI') && WP_CLI) return;

    $path = strtok($_SERVER['REQUEST_URI'], '?');
    if (strncmp($path, '/wp-', 4) === 0) return;

    // A site's own callback, which header_register_callback gives one slot.
    if (isset($_SERVER['HTTP_X_TEST_OWN_CALLBACK'])) {
        header_register_callback(function () {
            header('x-site-callback: ran');
        });
    }

    // A download as WooCommerce sends one: every buffer closed, then its own headers.
    if ($path === '/download') {
        while (ob_get_level() > 0) ob_end_clean();
        header('Content-Type: application/octet-stream');
        header('Cache-Control: public, max-age=3600');
        echo 'file bytes';
        exit;
    }

    // Reads php://input itself, as a plugin outside the REST API would.
    if ($path === '/mcp-raw') {
        // A plugin emptying the buffer it is in, or closing every one, before it answers.
        if (isset($_SERVER['HTTP_X_TEST_OB_CLEAN'])) ob_clean();
        if (isset($_SERVER['HTTP_X_TEST_END_CLEAN'])) while (ob_get_level() > 0) ob_end_clean();
        $call = json_decode(file_get_contents('php://input'), true);
        header('Content-Type: application/json');
        echo dna_test_json(['jsonrpc' => '2.0', 'id' => $call['id'] ?? null, 'result' => dna_test_mcp_result($call)]);
        exit;
    }

    if ($path === '/mcp-sse') {
        $call = json_decode(file_get_contents('php://input'), true);
        header('Content-Type: text/event-stream');
        echo "event: message\ndata: " . dna_test_json(['jsonrpc' => '2.0', 'id' => $call['id'] ?? null, 'result' => dna_test_mcp_result($call)]) . "\n\n";
        exit;
    }

    // A plugin calling the REST API in-process while it renders a page.
    $internal = null;
    if (isset($_SERVER['HTTP_X_TEST_INTERNAL_POST'])) {
        $request = new WP_REST_Request('POST', '/dna-test/v1/mcp');
        $request->set_body('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
        $internal = rest_do_request($request)->get_status();
    }

    $cc = $_SERVER['HTTP_X_TEST_ORIGIN_CC'] ?? 'public, max-age=60';
    header('Content-Type: application/json');
    if ($cc !== '(absent)') header('Cache-Control: ' . $cc);
    if (isset($_SERVER['HTTP_X_TEST_ORIGIN_RECEIPT'])) header('Payment-Receipt: ' . $_SERVER['HTTP_X_TEST_ORIGIN_RECEIPT']);
    setcookie('site_session', 'KEEP', 0, '/');
    header('Access-Control-Expose-Headers: x-site-thing');

    $raw = file_get_contents('php://input');
    echo dna_test_json([
        'origin' => true,
        'entry' => defined('D3_DNA_ENTRY') ? D3_DNA_ENTRY : null,
        'pageCacheSkipped' => defined('DONOTCACHEPAGE'),
        'internalPost' => $internal,
        'url' => $_SERVER['REQUEST_URI'],
        'query' => $_SERVER['QUERY_STRING'] ?? '',
        'method' => $_SERVER['REQUEST_METHOD'],
        'headers' => dna_test_request_headers(),
        'get' => (object) wp_unslash($_GET),
        'request' => (object) wp_unslash($_REQUEST),
        'cookies' => (object) wp_unslash($_COOKIE),
        'files' => array_keys($_FILES),
        // The other copies of the request PHP keeps.
        'argv' => $_SERVER['argv'] ?? null,
        'redirectQuery' => $_SERVER['REDIRECT_QUERY_STRING'] ?? null,
        'env' => array_intersect_key($_ENV, array_flip(['HTTP_COOKIE', 'HTTP_X_PAYMENT', 'HTTP_X_D3_TIER', 'QUERY_STRING', 'REQUEST_URI'])),
        'bodyBytes' => strlen($raw),
        'body' => strlen($raw) <= 65536 ? $raw : null,
    ]);
    exit;
}, 0);

// The MCP server most WordPress sites would run: a route on the REST API, which reads the body through get_raw_data().
add_action('rest_api_init', function () {
    register_rest_route('dna-test/v1', '/mcp', [
        // POST, PUT and PATCH: an override to any of them runs the tool.
        'methods' => WP_REST_Server::EDITABLE,
        'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $request) {
            $call = json_decode($request->get_body(), true);
            $response = new WP_REST_Response(['jsonrpc' => '2.0', 'id' => $call['id'] ?? null, 'result' => dna_test_mcp_result($call)]);
            $response->header('ETag', '"v1"');
            $response->header('Cache-Control', 'public, max-age=60');
            return $response;
        },
    ]);
});
