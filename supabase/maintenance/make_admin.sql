-- Makes ONE account an admin (can open admin.html). Replace the email, then run in the SQL Editor.
update public.profiles set is_admin = true
 where id = (select id from auth.users where email = 'YOUR_EMAIL');
select u.email, p.is_admin from public.profiles p join auth.users u on u.id = p.id where p.is_admin;
