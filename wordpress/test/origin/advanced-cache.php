<?php
// A page cache as WP Super Cache and W3 Total Cache run one: from wp-settings.php,
// before any plugin loads. Serves /cached as a hit.
if (strncmp($_SERVER['REQUEST_URI'] ?? '', '/cached', 7) === 0) {
    header('Content-Type: application/json');
    echo json_encode(['cached' => true, 'entry' => defined('D3_DNA_ENTRY') ? D3_DNA_ENTRY : null, 'cookie' => $_SERVER['HTTP_COOKIE'] ?? null, 'request' => array_keys($_REQUEST)]);
    exit;
}
