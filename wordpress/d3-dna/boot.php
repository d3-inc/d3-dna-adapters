<?php
/**
 * DNA by D3, before WordPress runs. wp-config.php includes this above
 * wp-settings.php (README.md, Install), so it runs before any page cache; the
 * must-use loader and d3-dna.php include it too, and whichever comes first runs.
 */

if (defined('D3_DNA_ENTRY')) return;

define('D3_DNA_ENTRY', !function_exists('did_action') ? 'wp-config' : (did_action('muplugins_loaded') ? 'plugin' : 'mu-plugin'));
if (PHP_SAPI === 'cli' || PHP_SAPI === 'phpdbg') return;

/*
 * Without our code (a plugin update half done, a file edited) nothing can read a
 * query or a body properly. Our headers and cookies go by name, matched loosely;
 * a request carrying a payment, or anything that may be one, is refused rather
 * than handed to WordPress. A closure, not a function: a second copy of this
 * file must not redeclare it.
 */
$d3_dna_refuse_unloaded = function () {
    $ours = false;
    foreach (['PAYMENT_SIGNATURE', 'X_PAYMENT', 'PAYMENT_AUTHORIZATION', 'D3PAY_SESSION', 'MCP_PARAM_DNA_KEY'] as $name) {
        $ours = $ours || (($_SERVER['HTTP_' . $name] ?? '') !== '');
        unset($_SERVER['HTTP_' . $name]);
    }
    unset($_SERVER['HTTP_X_D3_TIER'], $_SERVER['HTTP_X_D3_IDENTITY'], $_SERVER['HTTP_D3PAY_PERSON']);
    unset($_ENV['HTTP_X_D3_TIER'], $_ENV['HTTP_X_D3_IDENTITY'], $_ENV['HTTP_D3PAY_PERSON']);

    $cookie = (string) ($_SERVER['HTTP_COOKIE'] ?? '');
    $ours = $ours || strpos($cookie, '__Host-d3pay') !== false;
    $kept = [];
    foreach (explode(';', $cookie) as $pair) {
        if (stripos($pair, '__Host-d3') === false && stripos($pair, '__Secure-d3') === false) $kept[] = trim($pair);
    }
    $kept = implode('; ', array_filter($kept, 'strlen'));
    if ($kept === '') {
        unset($_SERVER['HTTP_COOKIE']);
    } else {
        $_SERVER['HTTP_COOKIE'] = $kept;
    }
    foreach (array_keys($_COOKIE) as $name) {
        if (stripos((string) $name, '__Host-d3') === 0 || stripos((string) $name, '__Secure-d3') === 0) unset($_COOKIE[$name]);
    }

    // Matched loosely, so `d3pay%5Fhandoff` and a key behind a JSON escape count too.
    $body = (string) @file_get_contents('php://input', false, null, 0, 1048577);
    $ours = $ours
        || stripos(rawurldecode((string) ($_SERVER['QUERY_STRING'] ?? '')), 'd3pay_') !== false
        || preg_match('~dna_account_key|dna\.d3\.com\\\\?/key|x402\\\\?/payment~i', $body) === 1
        || (strpos($body, 'jsonrpc') !== false && (strpos($body, '\\u') !== false || strlen($body) > 1048576));

    if (!$ours) {
        header('x-d3-edge: fail-open');
        return;
    }

    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('x-d3-edge: fail-closed');
    echo '{"error":"payment_unavailable"}';
    exit;
};

$d3_dna_loaded = false;
try {
    // Silenced: a warning printed here would send WordPress's headers early.
    $d3_dna_loaded = (@include_once __DIR__ . '/src/Protocol.php')
        && (@include_once __DIR__ . '/src/Memory.php')
        && (@include_once __DIR__ . '/src/InputStream.php')
        && (@include_once __DIR__ . '/src/Runtime.php');
} catch (\Throwable $e) {
    error_log('d3-dna: cannot load, so DNA is off for this request: ' . $e->getMessage());
}

if ($d3_dna_loaded) {
    \D3\Dna\Runtime::run();
} else {
    // Once a minute, not per request: Memory.php, which throttles the rest, may be what is missing.
    // Where open_basedir keeps PHP out of every temp directory, every request says so.
    $d3_dna_dir = null;
    foreach ([sys_get_temp_dir(), (string) ini_get('upload_tmp_dir')] as $d3_dna_candidate) {
        if ($d3_dna_dir === null && $d3_dna_candidate !== '' && @is_writable($d3_dna_candidate)) $d3_dna_dir = $d3_dna_candidate;
    }
    $d3_dna_marker = $d3_dna_dir === null ? null : $d3_dna_dir . '/d3-dna-unloaded-' . md5(__DIR__);
    if ($d3_dna_marker === null || (@filemtime($d3_dna_marker) < time() - 60 && @touch($d3_dna_marker))) {
        error_log('d3-dna: a file under ' . __DIR__ . '/src is missing, so DNA is off and anything of ours is refused');
    }
    unset($d3_dna_marker, $d3_dna_dir, $d3_dna_candidate);
    $d3_dna_refuse_unloaded();
}
unset($d3_dna_loaded, $d3_dna_refuse_unloaded);
