<?php
// php://input answering the MCP call with our credential lifted out of it. PHP
// cannot rewrite a request body, so this takes over the php:// wrapper for the
// rest of the request: php://input reads the stripped call, and every other
// php:// stream (output, memory, temp, filter) opens through PHP's own wrapper.
// Installed only on a request whose body DNA rewrote.

namespace D3\Dna;

final class InputStream
{
    /** @var string */
    private static $body = '';

    /** @var resource|null set by PHP on each opened stream */
    public $context;

    /** @var resource|null PHP's own stream, for every php:// path but input */
    private $inner = null;
    private $position = 0;

    public static function install($body)
    {
        self::$body = $body;
        if (in_array('php', stream_get_wrappers(), true)) stream_wrapper_unregister('php');
        stream_wrapper_register('php', self::class);
    }

    /** Runs with PHP's own php:// wrapper back in place, then ours again. */
    private static function withPhpWrapper(callable $open)
    {
        stream_wrapper_restore('php');
        try {
            return $open();
        } finally {
            stream_wrapper_unregister('php');
            stream_wrapper_register('php', self::class);
        }
    }

    public function stream_open($path, $mode, $options, &$openedPath)
    {
        $target = strtolower($path);
        if ($target === 'php://input') return true;

        // A filter over php://input would read the original body, credential and all.
        if (strpos($target, 'php://filter/') === 0 && strpos(rawurldecode($target), 'php://input') !== false) {
            if ($options & STREAM_REPORT_ERRORS) trigger_error('d3-dna: php://filter over php://input is not available on this request', E_USER_WARNING);
            return false;
        }

        $context = $this->context;
        $inner = self::withPhpWrapper(function () use ($path, $mode, $context) {
            return $context !== null ? @fopen($path, $mode, false, $context) : @fopen($path, $mode);
        });
        if ($inner === false) return false;

        $this->inner = $inner;
        return true;
    }

    public function stream_read($count)
    {
        if ($this->inner !== null) return fread($this->inner, $count);

        $chunk = (string) substr(self::$body, $this->position, $count);
        $this->position += strlen($chunk);
        return $chunk;
    }

    public function stream_write($data)
    {
        return $this->inner !== null ? fwrite($this->inner, $data) : 0;
    }

    public function stream_eof()
    {
        return $this->inner !== null ? feof($this->inner) : $this->position >= strlen(self::$body);
    }

    public function stream_tell()
    {
        return $this->inner !== null ? ftell($this->inner) : $this->position;
    }

    public function stream_seek($offset, $whence)
    {
        if ($this->inner !== null) return fseek($this->inner, $offset, $whence) === 0;

        $length = strlen(self::$body);
        $to = $whence === SEEK_SET ? $offset : ($whence === SEEK_CUR ? $this->position + $offset : $length + $offset);
        if ($to < 0) return false;

        $this->position = $to;
        return true;
    }

    public function stream_flush()
    {
        return $this->inner !== null ? fflush($this->inner) : true;
    }

    public function stream_truncate($size)
    {
        return $this->inner !== null && ftruncate($this->inner, $size);
    }

    public function stream_lock($operation)
    {
        return $this->inner !== null && flock($this->inner, $operation);
    }

    public function stream_set_option($option, $arg1, $arg2)
    {
        return false;
    }

    public function stream_stat()
    {
        if ($this->inner !== null) return fstat($this->inner);

        return ['size' => strlen(self::$body), 'mode' => 0100444];
    }

    public function url_stat($path, $flags)
    {
        return strtolower($path) === 'php://input' ? ['size' => strlen(self::$body), 'mode' => 0100444] : false;
    }

    public function stream_close()
    {
        if ($this->inner !== null) fclose($this->inner);
        $this->inner = null;
    }
}
