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
        if (self::hasApcu()) return apcu_add(self::id($key), true, (int) $seconds);

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
            apcu_store(self::id($key), true, (int) $seconds);
            return;
        }

        $file = self::file($key);
        if ($file !== null) @touch($file);
    }

    /** Whether the flag was set within the last $seconds. */
    public static function holds($key, $seconds)
    {
        if (self::hasApcu()) return apcu_fetch(self::id($key)) === true;

        $file = self::file($key);
        $at = $file === null ? false : @filemtime($file);
        return $at !== false && $at > time() - $seconds;
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

    // Per install, so two sites on one server keep their own.
    private static function id($key)
    {
        return 'd3-dna-' . md5(__DIR__ . "\0" . $key);
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

        $sessionPath = (string) ini_get('session.save_path');
        $candidates = [sys_get_temp_dir(), (string) ini_get('upload_tmp_dir'), substr($sessionPath, (int) strrpos($sessionPath, ';'))];
        $dir = null;
        foreach ($candidates as $candidate) {
            $candidate = rtrim(ltrim($candidate, ';'), '/\\');
            if ($candidate !== '' && @is_dir($candidate) && @is_writable($candidate)) {
                $dir = $candidate;
                break;
            }
        }

        return $dir;
    }
}
