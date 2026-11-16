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

    /** The home page fetched as a visitor would, for the `x-d3-edge` it comes back with, and when. */
    public static function runCheck()
    {
        if (!current_user_can('manage_options')) wp_die('', 403);
        check_admin_referer(self::CHECK_ACTION);

        $response = wp_remote_get(home_url('/'), ['timeout' => 15, 'redirection' => 0, 'sslverify' => false]);
        $edge = is_wp_error($response) ? 'error' : (string) wp_remote_retrieve_header($response, 'x-d3-edge');
        set_transient('d3_dna_check_' . get_current_user_id(), ['edge' => $edge === '' ? '(none)' : $edge, 'at' => time()], 300);
        wp_safe_redirect(admin_url('tools.php?page=' . self::PAGE));
        exit;
    }

    private static function meaningOf($edge)
    {
        $home = home_url('/');
        $meanings = [
            'pass' => 'DNA is live.',
            'disabled' => 'DNA is off: DNA_ENABLED is false, or this server cannot see DNA_API_KEY.',
            'fail-open' => 'DNA could not be reached, or PHP has no curl, so the page was served. The PHP error log says which.',
            'fail-closed' => 'DNA could not be reached and DNA_FAIL_MODE is closed, so visitors get a 403. The PHP error log says why.',
            '(none)' => "Something answered your home page before PHP ran DNA: your host's cache, a caching plugin's file, or a redirect from your web server. Check that $home is your site's final address, then turn that cache off for a test.",
            'error' => "WordPress could not reach its own home page from this server. From another machine, run curl -sI $home and look for x-d3-edge.",
        ];

        return $meanings[$edge] ?? 'DNA is live: a rule answered your home page itself.';
    }

    /** One line that says whether DNA protects the site, and what to do when it doesn't. */
    private static function verdict(array $settings, $entry)
    {
        if ($settings['endpoint'] === null) {
            return Runtime::setting('DNA_ENABLED') !== null && strtolower(trim(Runtime::setting('DNA_ENABLED'))) === 'false'
                ? 'DNA is off: DNA_ENABLED is false.'
                : 'DNA is off: add DNA_API_KEY to wp-config.php (Setup below).';
        }
        if (!function_exists('curl_init')) return "DNA can't run: install PHP's curl extension. Until then every page is served as if DNA could not be reached.";
        if ($entry !== 'wp-config') return 'DNA is on, but cached pages skip it: add the wp-config.php lines below.';
        if (Runtime::siteHosts() === []) return 'DNA is on, but a visitor can send another host name and skip your rules: add DNA_HOSTS (Setup below).';

        return 'DNA is on, before any page cache.';
    }

    public static function renderPage()
    {
        if (!current_user_can('manage_options')) return;

        if (!class_exists(Runtime::class)) {
            echo '<div class="wrap"><h1>DNA by D3</h1><p>Part of the plugin is missing: reinstall it.</p></div>';
            return;
        }

        $settings = Runtime::settings();
        $entry = defined('D3_DNA_ENTRY') ? D3_DNA_ENTRY : null;
        $check = get_transient('d3_dna_check_' . get_current_user_id());
        $key = $settings['api_key'];
        $hosts = Runtime::siteHosts();
        $named = array_merge($settings['exclude']['headers'], $settings['exclude']['cookies']);

        $rows = [
            'Runs from' => [
                'wp-config' => 'wp-config.php, before any page cache',
                'mu-plugin' => 'the must-use loader, after a page cache',
                'plugin' => 'the plugin itself, after a page cache and the must-use plugins',
            ][$entry] ?? 'nowhere: reinstall the plugin',
            'Endpoint' => $settings['endpoint'] ?? 'none',
            'Hosts' => $hosts === [] ? 'not set' : implode(', ', $hosts),
            'API key' => $key !== null && $key !== '' ? 'set, ending ' . substr($key, -4) : 'not set',
            'If DNA cannot answer' => $settings['fail_mode'] === 'closed' ? 'answer 403 (DNA_FAIL_MODE is closed)' : 'serve the page',
            'Time limit' => $settings['timeout_ms'] . ' ms, ' . $settings['payment_timeout_ms'] . ' ms for a request that pays',
            'Kept back' => ($named === [] ? '' : implode(', ', $named) . '; ')
                . "always Authorization, Proxy-Authorization, and WordPress's login, post-password and WooCommerce session cookies",
            'Outcome reports' => function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request')
                ? 'sent after each response'
                : 'not sent: needs PHP-FPM or LiteSpeed. Your rules still apply.',
        ];
        $boot = var_export(dirname(__DIR__) . '/boot.php', true);
        $hostsSetting = implode(',', $hosts) ?: (string) Runtime::hostOf(home_url());
        $config = "define('DNA_API_KEY', 'your key from dashboard.d3.com/keys');\n"
            . 'define(\'DNA_HOSTS\', ' . var_export($hostsSetting, true) . ");\n"
            . "if (is_file($boot)) include $boot;";

        echo '<div class="wrap"><h1>DNA by D3</h1>';
        echo '<p><strong>' . esc_html(self::verdict($settings, $entry)) . '</strong></p>';
        echo '<table class="widefat striped"><tbody>';
        foreach ($rows as $label => $value) {
            echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html($value) . '</td></tr>';
        }
        echo '</tbody></table>';

        echo '<h2>Check</h2><p>Fetches your home page as a visitor would and reads the <code>x-d3-edge</code> header on it.</p>';
        if (is_array($check)) {
            echo '<p>Last check, ' . esc_html(date_i18n(get_option('time_format'), $check['at'])) . ': <strong>'
                . esc_html($check['edge']) . '</strong>. ' . esc_html(self::meaningOf($check['edge'])) . '</p>';
        }
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="' . esc_attr(self::CHECK_ACTION) . '">';
        wp_nonce_field(self::CHECK_ACTION);
        submit_button('Check the home page', 'secondary', 'submit', false);
        echo '</form>';

        echo '<h2>Setup</h2><p>Add these lines to <code>wp-config.php</code>, above the line that requires <code>wp-settings.php</code>. ';
        echo 'They set your key and your domains, and run DNA before any page cache. Settings live there or in the server environment, never in the database.</p>';
        echo '<pre>' . esc_html($config) . '</pre>';
        echo "<p>To turn DNA off, add <code>define('DNA_ENABLED', false);</code>. Deactivating the plugin leaves these lines running.</p>";
        echo '</div>';
    }
}
