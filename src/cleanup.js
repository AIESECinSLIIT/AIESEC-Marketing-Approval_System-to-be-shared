// Keep the durable job until Storage confirms deletion; retries are idempotent.
export async function deleteCreativeFiles(client, id, version) {
  const checked = (result) => {
    if (result.error)
      throw new Error(result.error.message || "Cleanup failed. Please retry.");
    return result.data;
  };
  const job = checked(
    await client.rpc("club_begin_cleanup", { p_id: id, p_version: version }),
  );
  if (!job.completedAt) {
    for (let offset = 0; offset < job.paths.length; offset += 100)
      checked(
        await client.storage
          .from("creatives")
          .remove(job.paths.slice(offset, offset + 100)),
      );
  }
  return checked(await client.rpc("club_finish_cleanup", { p_job: job.jobId }));
}
