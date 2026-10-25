"""Explicitly approved local shell, with process-group cleanup and bounded output.

The working directory is a convenience, not a filesystem or network sandbox.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import signal
import tempfile


async def run_shell(command: str, directory: Path, seconds: int = 20) -> dict:
    if not command.strip() or len(command) > 8000 or "\x00" in command:
        raise ValueError("命令不能为空、包含NUL或超过8000字符")
    if directory.is_symlink():
        raise ValueError("Agent工作目录不能是符号链接")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    process = await asyncio.create_subprocess_exec(
        "/bin/zsh", "-f", "-c", command, cwd=directory,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "TMPDIR": tempfile.gettempdir()},
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=True,
    )
    output = bytearray()
    limited = False

    async def read_output():
        nonlocal limited
        while chunk := await process.stdout.read(4096):
            remaining = 65536 - len(output)
            output.extend(chunk[:remaining])
            if len(chunk) > remaining:
                limited = True
                raise OverflowError("shell-output-limit")
    reader = asyncio.create_task(read_output())
    waiter = asyncio.create_task(process.wait())
    status = "completed"
    try:
        await asyncio.wait_for(asyncio.gather(reader, waiter), max(1, min(seconds, 30)))
        if process.returncode != 0:
            status = "failed"
    except TimeoutError:
        status = "timeout"
    except OverflowError:
        status = "output_limit"
    finally:
        # Kill descendants even when zsh itself already exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        for task in (reader, waiter):
            if not task.done():
                task.cancel()
        await asyncio.gather(reader, waiter, return_exceptions=True)
        await process.wait()
    return {"status": status, "exitCode": process.returncode, "output": output.decode("utf-8", "replace"),
            "outputTruncated": limited, "timeoutSeconds": seconds, "outputLimitBytes": 65536,
            "boundary": "本机用户权限，工作目录不是沙箱；可能修改文件或发送网络请求，不自动重试、不保证可撤销。"}
