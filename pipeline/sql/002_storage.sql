-- Storage policies for the photos bucket.
--
-- The bucket is PRIVATE. The account page promises "private unless you say
-- otherwise", and a public bucket would make that false — every object would
-- be readable by anyone who had or guessed the URL, regardless of the
-- is_public flag. So reads go through short-lived signed URLs, and the
-- policies below decide who may ask for one.
--
-- Paths are `<household_id>/<recipe_id>/<uuid>.<ext>`, so the first path
-- segment is the household and can be checked directly.

-- Upload: only into your own household's folder.
drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth_household()::text
  );

-- Read: your household's own photos...
drop policy if exists photos_select_own on storage.objects;
create policy photos_select_own on storage.objects for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth_household()::text
  );

-- ...or any photo whose row has been explicitly shared. This is what makes a
-- public gallery possible later without changing the storage model or asking
-- everyone for consent a second time.
drop policy if exists photos_select_shared on storage.objects;
create policy photos_select_shared on storage.objects for select to anon, authenticated
  using (
    bucket_id = 'photos'
    and exists (
      select 1 from public.recipe_photos p
      where p.storage_path = storage.objects.name and p.is_public
    )
  );

-- Delete: only your own household's.
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth_household()::text
  );
