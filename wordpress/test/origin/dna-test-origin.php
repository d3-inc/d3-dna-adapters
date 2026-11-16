<?php
/**
 * Plugin Name: DNA test origin
 * Description: The site behind DNA in wordpress/test: echoes what WordPress was handed, and authors its own Set-Cookie, CORS list and caching.
 */

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
    $path = strtok($_SERVER['REQUEST_URI'], '?');
    if (strncmp($path, '/wp-', 4) === 0) return;

    // Reads php://input itself, as a plugin outside the REST API would.
    if ($path === '/mcp-raw') {
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
        'url' => $_SERVER['REQUEST_URI'],
        'query' => $_SERVER['QUERY_STRING'] ?? '',
        'method' => $_SERVER['REQUEST_METHOD'],
        'headers' => dna_test_request_headers(),
        'get' => (object) wp_unslash($_GET),
        'request' => (object) wp_unslash($_REQUEST),
        'cookies' => (object) wp_unslash($_COOKIE),
        'files' => array_keys($_FILES),
        'bodyBytes' => strlen($raw),
        'body' => strlen($raw) <= 65536 ? $raw : null,
    ]);
    exit;
}, 0);

// The MCP server most WordPress sites would run: a route on the REST API, which reads the body through get_raw_data().
add_action('rest_api_init', function () {
    register_rest_route('dna-test/v1', '/mcp', [
        'methods' => 'POST',
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
