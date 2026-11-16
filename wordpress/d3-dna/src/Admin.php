<?php
// The plugin's WordPress half: the must-use loader it installs on activation,
// and a read-only status screen under Tools. Settings are never stored here:
// they live in wp-config.php or the server's environment.

namespace D3\Dna;

final class Admin
{
    const LOADER = '0-d3-dna-loader.php';
    const PAGE = 'd3-dna';
    const CHECK_ACTION = 'd3_dna_check';
    const LOADER_MARK = '// Installed by the DNA by D3 plugin, which removes it on deactivation.';

    public static function register()
    {
        add_action('admin_menu', [self::class, 'addPage']);
        add_action('admin_post_' . self::CHECK_ACTION, [self::class, 'runCheck']);
    }

    public static function loaderPath()
    {
        return WPMU_PLUGIN_DIR . '/' . self::LOADER;
    }

    /**
     * The loader runs DNA before the site's other plugins load. Guarded, so a
     * plugin deleted by hand never takes the site down; by WP_PLUGIN_DIR, so a
     * copy of the site elsewhere runs its own plugin.
     */
    public static function loaderSource()
    {
        $boot = var_export('/' . basename(dirname(__DIR__)) . '/boot.php', true);
        return "<?php\n" . self::LOADER_MARK . "\n"
            . "if (is_file(WP_PLUGIN_DIR . $boot)) include_once WP_PLUGIN_DIR . $boot;\n";
    }

    /** A must-use plugin runs on every site of a network, so only a network activation installs one. */
    public static function installLoader($networkWide = false)
    {
        if (is_multisite() && !$networkWide) return;
        if (!is_dir(WPMU_PLUGIN_DIR) && !wp_mkdir_p(WPMU_PLUGIN_DIR)) return;

        @file_put_contents(self::loaderPath(), self::loaderSource());
    }

    public static function removeLoader($networkWide = false)
    {
        if (is_multisite() && !$networkWide) return;

        $path = self::loaderPath();
        // Only ours, whichever version wrote it: a file of that name someone else wrote stays.
        if (is_file($path) && strpos((string) @file_get_contents($path), self::LOADER_MARK) !== false) @unlink($path);
    }

    public static function addPage()
    {
        add_management_page('DNA by D3', 'DNA', 'manage_options', self::PAGE, [self::class, 'renderPage']);
    }

    /** The home page fetched as a visitor would, for the `x-d3-edge` it comes back with. */
    public static function runCheck()
    {
        if (!current_user_can('manage_options')) wp_die('', 403);
        check_admin_referer(self::CHECK_ACTION);

        $response = wp_remote_get(home_url('/'), ['timeout' => 15, 'redirection' => 0, 'sslverify' => false]);
        $edge = is_wp_error($response) ? 'error: ' . $response->get_error_message() : (string) wp_remote_retrieve_header($response, 'x-d3-edge');
        set_transient('d3_dna_check_' . get_current_user_id(), $edge === '' ? '(none)' : $edge, 300);
        wp_safe_redirect(admin_url('tools.php?page=' . self::PAGE));
        exit;
    }

    private static function meaningOf($edge)
    {
        $meanings = [
            'pass' => 'DNA is live.',
            'disabled' => 'DNA is off: DNA_ENABLED is false, or this server cannot see DNA_API_KEY.',
            'fail-open' => 'DNA could not be reached, or PHP lacks curl. The PHP error log says which.',
            '(none)' => 'DNA did not run on that page. Check that the plugin is active, or add the wp-config.php line below.',
        ];

        return $meanings[$edge] ?? 'DNA answered that page itself, as a rule says.';
    }

    private static function hostsRow()
    {
        if (!class_exists(Runtime::class)) return '';

        $hosts = Runtime::siteHosts();
        return $hosts === []
            ? 'not set: a request can name a host with no rules. Define DNA_HOSTS as the setup below shows.'
            : implode(', ', $hosts);
    }

    public static function renderPage()
    {
        if (!current_user_can('manage_options')) return;

        $settings = class_exists(Runtime::class) ? Runtime::settings() : null;
        $entry = defined('D3_DNA_ENTRY') ? D3_DNA_ENTRY : null;
        $check = get_transient('d3_dna_check_' . get_current_user_id());
        $key = $settings === null ? null : $settings['api_key'];

        $rows = [
            'Runs from' => [
                'wp-config' => 'wp-config.php, before any page cache.',
                'mu-plugin' => 'the must-use loader. A page cache serves its hits before DNA runs: add the wp-config.php line below.',
                'plugin' => 'the plugin itself, after the must-use plugins. A page cache serves its hits before DNA runs: add the wp-config.php line below.',
            ][$entry] ?? 'nowhere on this request.',
            'Endpoint' => $settings !== null && $settings['endpoint'] !== null ? $settings['endpoint'] : 'off: no DNA_API_KEY, or DNA_ENABLED is false',
            'Hosts' => self::hostsRow(),
            'API key' => $key !== null && $key !== '' ? 'set, ending ' . substr($key, -4) : 'not set',
            'If DNA cannot answer' => $settings !== null && $settings['fail_mode'] === 'closed' ? 'block (DNA_FAIL_MODE=closed)' : 'serve the page',
            'Time limit' => $settings !== null ? $settings['timeout_ms'] . ' ms, ' . $settings['payment_timeout_ms'] . ' ms for a request that pays' : '',
            'Kept back' => $settings !== null
                ? count($settings['exclude']['headers']) . ' headers, ' . count($settings['exclude']['cookies']) . ' cookies'
                : '',
            'curl' => function_exists('curl_init') ? 'available' : 'missing: every request is handled as if DNA could not be reached',
            'Reports' => function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request')
                ? 'sent after each response'
                : 'not sent: this server cannot end a response before PHP finishes',
        ];
        $boot = var_export(dirname(__DIR__) . '/boot.php', true);
        $hosts = class_exists(Runtime::class) ? (implode(',', Runtime::siteHosts()) ?: (string) Runtime::hostOf(home_url())) : '';
        $config = "// Above the line that requires wp-settings.php:\ndefine('DNA_API_KEY', 'your key from dashboard.d3.com/keys');\n"
            . 'define(\'DNA_HOSTS\', ' . var_export($hosts, true) . ");\n"
            . "if (is_file($boot)) include $boot;";

        echo '<div class="wrap"><h1>DNA by D3</h1>';
        echo '<table class="widefat striped" style="max-width:48rem"><tbody>';
        foreach ($rows as $label => $value) {
            echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html($value) . '</td></tr>';
        }
        echo '</tbody></table>';

        echo '<h2>Check</h2><p>Fetches your home page as a visitor would and reads the <code>x-d3-edge</code> header on it.</p>';
        if (is_string($check)) {
            echo '<p><strong>' . esc_html($check) . '</strong>: ' . esc_html(self::meaningOf($check)) . '</p>';
        }
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="' . esc_attr(self::CHECK_ACTION) . '">';
        wp_nonce_field(self::CHECK_ACTION);
        submit_button('Check the home page', 'secondary', 'submit', false);
        echo '</form>';

        echo '<h2>Setup</h2><p>Settings live in <code>wp-config.php</code> or the server environment, never in the database. ';
        echo 'These lines in <code>wp-config.php</code> set your key and run DNA before any page cache:</p>';
        echo '<pre style="max-width:48rem;white-space:pre-wrap">' . esc_html($config) . '</pre>';
        echo '<p>Deactivating the plugin does not remove that line: to turn DNA off, define <code>DNA_ENABLED</code> as <code>false</code>.</p>';
        echo '</div>';
    }
}
