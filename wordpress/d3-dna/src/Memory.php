<?php
// A few flags this server's PHP requests share, each for some seconds: APCu
// where there is one, else a file's age in a temp directory PHP may write to.
// PHP keeps nothing between requests by itself, and most hosts have no APCu.

namespace D3\Dna;

final class Memory
{
    /** Sets the flag unless it is already set; whether this call set it. */
    public static function claim($key, $seconds)
    {
        if (self::hasApcu()) return apcu_add(self::id($key), time(), (int) $seconds);

        $file = self::file($key);
        if ($file === null) return true;

        $at = @filemtime($file);
        if ($at !== false && $at > time() - $seconds) return false;

        @touch($file);
        return true;
    }

    public static function hold($key, $seconds)
    {
        if (self::hasApcu()) {
            apcu_store(self::id($key), time(), (int) $seconds);
            return;
        }

        $file = self::file($key);
        if ($file !== null) @touch($file);
    }

    /** Whether the flag was set within the last $seconds. */
    public static function holds($key, $seconds)
    {
        if (self::hasApcu()) {
            $at = apcu_fetch(self::id($key));
        } else {
            $file = self::file($key);
            $at = $file === null ? false : @filemtime($file);
        }

        return is_int($at) && $at > time() - $seconds;
    }

    /** Counts one more within a window that starts at the first; the count so far. */
    public static function count($key, $seconds)
    {
        if (self::hasApcu()) {
            apcu_add(self::id($key), 0, (int) $seconds);
            $n = apcu_inc(self::id($key));
            return is_int($n) ? $n : 1;
        }

        $file = self::file($key);
        if ($file === null) return 1;

        // "<window start> <count>": a write moves the file's time, so the start is kept in it.
        $parts = explode(' ', (string) @file_get_contents($file));
        $start = (int) $parts[0];
        $n = $start > time() - $seconds ? (int) ($parts[1] ?? 0) + 1 : 1;
        if ($n === 1) $start = time();
        @file_put_contents($file, "$start $n");

        return $n;
    }

    public static function drop($key)
    {
        if (self::hasApcu()) {
            apcu_delete(self::id($key));
            return;
        }

        $file = self::file($key);
        if ($file !== null) @unlink($file);
    }

    private static function hasApcu()
    {
        return function_exists('apcu_enabled') && apcu_enabled();
    }

    // Per install, and salted with the site's own secret where wp-config.php has set it: in a temp
    // directory other sites on the server share, a name they could guess is a flag they could set.
    private static function id($key)
    {
        $salt = defined('AUTH_KEY') ? (string) AUTH_KEY : '';
        return 'd3-dna-' . hash('sha256', $salt . "\0" . __DIR__ . "\0" . $key);
    }

    private static function file($key)
    {
        $dir = self::directory();
        return $dir === null ? null : $dir . DIRECTORY_SEPARATOR . self::id($key);
    }

    /** The first directory PHP may write to: open_basedir often leaves out the system's temp directory. */
    private static function directory()
    {
        static $dir = false;
        if ($dir !== false) return $dir;

        $dir = null;
        $sessionPath = (string) ini_get('session.save_path');
        foreach ([sys_get_temp_dir(), (string) ini_get('upload_tmp_dir'), substr($sessionPath, (int) strrpos($sessionPath, ';'))] as $candidate) {
            $candidate = rtrim(ltrim($candidate, ';'), '/\\');
            if ($candidate !== '' && @is_dir($candidate) && @is_writable($candidate)) return $dir = $candidate;
        }

        return $dir;
    }
}
