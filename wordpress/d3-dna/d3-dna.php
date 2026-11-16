<?php
/**
 * Plugin Name:       DNA by D3
 * Plugin URI:        https://ai.d3.com/docs/sdks/wordpress
 * Description:       Runs your DNA rules on each page WordPress serves: let AI agents in, block them, or charge them.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            D3
 * Author URI:        https://ai.d3.com
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 */

if (!defined('ABSPATH')) exit;

// Runs here only when neither wp-config.php nor the must-use loader ran it first.
include_once __DIR__ . '/boot.php';

if (is_file(__DIR__ . '/src/Admin.php')) {
    require_once __DIR__ . '/src/Admin.php';
    register_activation_hook(__FILE__, ['D3\\Dna\\Admin', 'installLoader']);
    register_deactivation_hook(__FILE__, ['D3\\Dna\\Admin', 'removeLoader']);
    \D3\Dna\Admin::register();
}
